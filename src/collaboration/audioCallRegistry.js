import { randomUUID } from 'node:crypto';

export const MAX_CALL_MEMBERS = 12;
export const MAX_CALL_CAMERAS = 6;

export class AudioCallRegistry {
  constructor() {
    this.callsById = new Map();
    this.callIdsByClientId = new Map();
  }

  findCallOfClient(clientId) {
    const callId = this.callIdsByClientId.get(clientId);
    return callId ? this.callsById.get(callId) : null;
  }

  inviteToCall({ inviterClientId, inviteeClientId }) {
    if (inviterClientId === inviteeClientId) {
      throw new Error("Impossible de s'appeler soi-même");
    }
    const existingCall = this.findCallOfClient(inviterClientId);
    if (existingCall && !existingCall.participantClientIds.has(inviterClientId)) {
      throw new Error('Vous êtes déjà en appel');
    }
    if (this.callIdsByClientId.has(inviteeClientId)) {
      throw new Error('Correspondant déjà en appel');
    }
    if (existingCall && countCallMembers(existingCall) >= MAX_CALL_MEMBERS) {
      throw new Error(`L'appel est complet (${MAX_CALL_MEMBERS} personnes maximum)`);
    }
    const call = existingCall ?? this.createCall(inviterClientId);
    call.invitedClientIds.add(inviteeClientId);
    this.callIdsByClientId.set(inviteeClientId, call.callId);
    return call;
  }

  createCall(callerClientId) {
    const call = {
      callId: randomUUID(),
      participantClientIds: new Set([callerClientId]),
      invitedClientIds: new Set(),
      cameraClientIds: new Set(),
    };
    this.callsById.set(call.callId, call);
    this.callIdsByClientId.set(callerClientId, call.callId);
    return call;
  }

  acceptCall(callId, inviteeClientId) {
    const call = this.callsById.get(callId);
    if (!call || !call.invitedClientIds.has(inviteeClientId)) {
      throw new Error('Appel introuvable');
    }
    call.invitedClientIds.delete(inviteeClientId);
    call.participantClientIds.add(inviteeClientId);
    return call;
  }

  leaveCall(call, clientId) {
    const wasInvited = call.invitedClientIds.delete(clientId);
    call.participantClientIds.delete(clientId);
    call.cameraClientIds.delete(clientId);
    this.callIdsByClientId.delete(clientId);
    const isEnded =
      call.participantClientIds.size === 0 || (call.participantClientIds.size === 1 && call.invitedClientIds.size === 0);
    if (isEnded) {
      this.callsById.delete(call.callId);
      for (const remainingClientId of [...call.participantClientIds, ...call.invitedClientIds]) {
        this.callIdsByClientId.delete(remainingClientId);
      }
    }
    return { wasInvited, isEnded };
  }

  setCamera(call, clientId, isEnabled) {
    if (!isEnabled) {
      call.cameraClientIds.delete(clientId);
      return;
    }
    if (!call.cameraClientIds.has(clientId) && call.cameraClientIds.size >= MAX_CALL_CAMERAS) {
      throw new Error(`${MAX_CALL_CAMERAS} caméras sont déjà allumées dans cet appel`);
    }
    call.cameraClientIds.add(clientId);
  }

  isInAcceptedCallWith(clientId, peerClientId) {
    const call = this.findCallOfClient(clientId);
    return (
      clientId !== peerClientId &&
      Boolean(call?.participantClientIds.has(clientId)) &&
      call.participantClientIds.has(peerClientId)
    );
  }
}

export function listOtherParticipants(call, clientId) {
  return [...call.participantClientIds].filter((participantClientId) => participantClientId !== clientId);
}

function countCallMembers(call) {
  return call.participantClientIds.size + call.invitedClientIds.size;
}
