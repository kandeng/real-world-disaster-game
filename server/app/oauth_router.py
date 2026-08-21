"""Google OAuth router with network-resilient CSRF validation.

fastapi-users v15's stock OAuth router rejects the callback whenever the
``fastapiusersoauthcsrf`` cookie set on ``/authorize`` is not echoed back.
On networks where an intermediate proxy/VPN swallows ``Set-Cookie`` headers
(observed in production: ``/authorize`` and ``/callback`` arriving through
different egress paths), legitimate sign-ins die with 400 OAUTH_INVALID_STATE
even though the code/token exchange with Google succeeded.

This router keeps the library's signed-state design but treats the cookie as
best-effort:

* cookie present AND state token present -> they must match (strict);
* cookie absent -> a valid, unexpired, server-signed state JWT is accepted
  (the state is unguessable and signed with our secret, which is the classic
  OAuth ``state`` CSRF defence);
* state token absent -> reject.

Everything else (token exchange, ``associate_by_email``, login response)
mirrors fastapi-users v15 exactly.
"""

import secrets
from urllib.parse import urlparse

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi_users.exceptions import UserAlreadyExists
from fastapi_users.jwt import decode_jwt
from fastapi_users.router.common import ErrorCode
from fastapi_users.router.oauth import (
    CSRF_TOKEN_COOKIE_NAME,
    CSRF_TOKEN_KEY,
    STATE_TOKEN_AUDIENCE,
    OAuth2AuthorizeResponse,
    generate_csrf_token,
    generate_state_token,
)
from httpx_oauth.integrations.fastapi import (
    OAuth2AuthorizeCallback,
    OAuth2AuthorizeCallbackError,
)
from httpx_oauth.oauth2 import GetAccessTokenError


def _resolve_redirect_url(request: Request, configured: str | None) -> str | None:
    """Pick the OAuth redirect_uri for this request.

    The SPA sends its own ``window.location.origin`` as the ``origin``
    query param so a user who started on ``https://www.…`` comes back to
    ``https://www.…/auth/callback`` instead of being flipped to the apex
    domain.  Only the apex/www variants of the configured frontend base
    URL (same scheme and port) are accepted; anything else — or no param
    at all — falls back to the configured URL.
    """
    if not configured:
        return None
    origin = request.query_params.get("origin")
    if not origin:
        return configured
    cfg = urlparse(configured)
    ori = urlparse(origin)
    if ori.scheme not in ("http", "https") or ori.scheme != cfg.scheme:
        return configured
    if ori.port != cfg.port:
        return configured
    host = cfg.hostname or ""
    bare = host[4:] if host.startswith("www.") else host
    if (ori.hostname or "") not in {bare, "www." + bare}:
        return configured
    return origin.rstrip("/") + cfg.path


class _DynamicRedirectCallback(OAuth2AuthorizeCallback):
    """Stock callback dependency, but the redirect_uri echoed in the
    token exchange is resolved per request — Google requires it to match
    exactly the one /authorize put in the authorization URL."""

    def __init__(self, client, redirect_url: str | None):
        super().__init__(client, redirect_url=redirect_url)
        self._configured = redirect_url

    async def __call__(
        self,
        request: Request,
        code: str | None = None,
        code_verifier: str | None = None,
        state: str | None = None,
        error: str | None = None,
    ):
        if code is None or error is not None:
            raise OAuth2AuthorizeCallbackError(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error if error is not None else None,
            )
        redirect_url = _resolve_redirect_url(request, self._configured)
        try:
            access_token = await self.client.get_access_token(
                code, redirect_url, code_verifier
            )
        except GetAccessTokenError as e:
            raise OAuth2AuthorizeCallbackError(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=e.message,
                response=e.response,
            ) from e
        return access_token, state


def get_resilient_oauth_router(
    oauth_client,
    backend,
    get_user_manager,
    state_secret,
    redirect_url: str | None = None,
    associate_by_email: bool = False,
    is_verified_by_default: bool = False,
    csrf_token_cookie_name: str = CSRF_TOKEN_COOKIE_NAME,
) -> APIRouter:
    router = APIRouter()
    oauth2_authorize_callback = _DynamicRedirectCallback(
        oauth_client, redirect_url=redirect_url
    )

    @router.get("/authorize", response_model=OAuth2AuthorizeResponse)
    async def authorize(request: Request, response: Response) -> OAuth2AuthorizeResponse:
        # Honour the caller's origin (www vs apex) so the browser comes
        # back to the same host it started from.
        redirect_uri = _resolve_redirect_url(request, redirect_url)
        csrf_token = generate_csrf_token()
        state = generate_state_token({CSRF_TOKEN_KEY: csrf_token}, state_secret)
        authorization_url = await oauth_client.get_authorization_url(
            redirect_uri, state, None
        )
        response.set_cookie(
            csrf_token_cookie_name,
            csrf_token,
            max_age=3600,
            path="/",
            secure=True,
            httponly=True,
            samesite="lax",
        )
        return OAuth2AuthorizeResponse(authorization_url=authorization_url)

    @router.get("/callback")
    async def callback(
        request: Request,
        access_token_state=Depends(oauth2_authorize_callback),
        user_manager=Depends(get_user_manager),
        strategy=Depends(backend.get_strategy),
    ):
        token, state = access_token_state

        try:
            state_data = decode_jwt(state, state_secret, [STATE_TOKEN_AUDIENCE])
        except jwt.DecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=ErrorCode.ACCESS_TOKEN_DECODE_ERROR,
            )
        except jwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=ErrorCode.ACCESS_TOKEN_ALREADY_EXPIRED,
            )

        state_csrf_token = state_data.get(CSRF_TOKEN_KEY)
        cookie_csrf_token = request.cookies.get(csrf_token_cookie_name)
        if not state_csrf_token:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=ErrorCode.OAUTH_INVALID_STATE,
            )
        if cookie_csrf_token:
            # Strict path: cookie survived the trip, it must match the state.
            if not secrets.compare_digest(cookie_csrf_token, state_csrf_token):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=ErrorCode.OAUTH_INVALID_STATE,
                )
        # Else: cookie stripped by a proxy/VPN on the way - the signed,
        # unexpired state JWT still proves the flow started at our /authorize.

        account_id, account_email = await oauth_client.get_id_email(
            token["access_token"]
        )
        if account_email is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=ErrorCode.OAUTH_NOT_AVAILABLE_EMAIL,
            )

        try:
            user = await user_manager.oauth_callback(
                oauth_client.name,
                token["access_token"],
                account_id,
                account_email,
                token.get("expires_at"),
                token.get("refresh_token"),
                request,
                associate_by_email=associate_by_email,
                is_verified_by_default=is_verified_by_default,
            )
        except UserAlreadyExists:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=ErrorCode.OAUTH_USER_ALREADY_EXISTS,
            )

        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=ErrorCode.LOGIN_BAD_CREDENTIALS,
            )

        response = await backend.login(strategy, user)
        await user_manager.on_after_login(user, request, response)
        return response

    return router
