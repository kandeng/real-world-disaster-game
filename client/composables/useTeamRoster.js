// ── Team roster (static, Phase A) ────────────────────────────────────────────
// The teammates shown in the AssistantPanel "Team" popover. One entry per
// chatroom participant: the human commander, the AI staff, and every machine
// asset (each machine's agent is a dedicated teammate).
//
// Names are localized: each entry carries a `nameKey` resolved through the
// shared vue-i18n instance (keys live in AssistantPanel.[locale].i18n.json).
// Machine avatars are placeholder silhouette thumbnails for now; they will be
// swapped for real renders of the mesh objects (assets/mesh/*.glb) once the
// thumbnail pipeline exists.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import commanderIcon from '../icons/commander.svg';
import staffIcon from '../icons/customer_service.svg';
import droneThumb from '../assets/media/teammates/drone01.svg';
import tankThumb from '../assets/media/teammates/tank01.svg';

const TEAM = [
  { id: 'commander', nameKey: 'assistantpanel.mate_commander', kind: 'human', avatar: commanderIcon },
  { id: 'staff01', nameKey: 'assistantpanel.mate_staff', kind: 'staff', avatar: staffIcon },
  { id: 'drone01', nameKey: 'assistantpanel.mate_drone01', kind: 'machine', avatar: droneThumb },
  { id: 'tank01', nameKey: 'assistantpanel.mate_tank01', kind: 'machine', avatar: tankThumb },
];

export function useTeamRoster() {
  const { t } = useI18n();
  // Resolve display names reactively so they follow the active locale.
  const team = computed(() => TEAM.map((mate) => ({ ...mate, name: t(mate.nameKey) })));
  return { team };
}
