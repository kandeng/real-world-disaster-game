"""One-time OAuth consent for the site's YouTube upload channel.

Run on a machine that has a browser (this dev box):

    /home/robot/miniconda3/envs/drone-navigation/bin/python \
        server/scripts/youtube_authorize.py

It opens Google's consent screen with the FULL `youtube` scope (videos.insert
upload + playlistItems.insert for the `drone-navigation` playlist) and, after
the operator approves, prints the long-lived REFRESH TOKEN. Paste that token
into server/config.json under a new "youtube" section:

    "youtube": { "refresh_token": "...", "privacy_status": "unlisted" }

The OAuth client id/secret are reused from the site login client
(deployment/tls/google_oauth.json -> web.client_id/client_secret).

One-time Google Cloud Console prerequisites on that client:
  * add http://localhost:8080/ to Authorized redirect URIs (exact trailing
    slash — run_local_server's default redirect has no /callback path);
  * OAuth consent screen: publishing status In production (unverified) with
    the operator's Google account listed under Test users — `youtube` is a
    restricted scope, so unverified apps can only be authorized by test users.
"""

import json
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

ROOT = Path(__file__).resolve().parents[2]
CRED_FILE = ROOT / "deployment" / "tls" / "google_oauth.json"

# Full youtube scope: upload (videos.insert) AND playlist management
# (playlistItems.insert). youtube.upload alone would not cover playlists.
SCOPES = ["https://www.googleapis.com/auth/youtube"]


def main() -> int:
    web = json.loads(CRED_FILE.read_text(encoding="utf-8"))["web"]
    client_config = {
        "installed": {
            "client_id": web["client_id"],
            "client_secret": web["client_secret"],
            "auth_uri": web["auth_uri"],
            "token_uri": web["token_uri"],
        }
    }
    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    creds = flow.run_local_server(
        port=8080,
        prompt="consent",  # force the consent screen so offline access grants
        access_type="offline",
        success_message="YouTube authorization complete. You can close this tab.",
    )
    if not creds.refresh_token:
        print("ERROR: Google returned no refresh token.", file=sys.stderr)
        return 1
    print()
    print("Paste this into server/config.json -> youtube.refresh_token:")
    print()
    print(creds.refresh_token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
