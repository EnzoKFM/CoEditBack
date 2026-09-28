import { randomUUID } from 'node:crypto';

export class AudioCallRegistry {
  constructor() {
    this.callsById = new Map();
    this.callIdsByClientId = new Map();
  }

  findCallOfClient(clientId) {
    const callId = this.callIdsByClientId.get(clientId);
    return callId ? this.callsById.get(callId) : null;
  }

  startCall({ callerClientId, calleeClientId }) {
    if (callerClientId === calleeClientId) {
      throw new Error("Impossible de s'appeler soi-même");
    }
    if (this.callIdsByClientId.has(callerClientId)) {
      throw new Error('Vous êtes déjà en appel');
    }
    if (this.callIdsByClientId.has(calleeClientId)) {
      throw new Error('Correspondant déjà en appel');
    }
    const call = { callId: randomUUID(), callerClientId, calleeClientId, isAccepted: false };
    this.callsById.set(call.callId, call);
    this.callIdsByClientId.set(callerClientId, call.callId);
    this.callIdsByClientId.set(calleeClientId, call.callId);
    return call;
  }

  acceptCall(callId, calleeClientId) {
    const call = this.callsById.get(callId);
    if (!call || call.calleeClientId !== calleeClientId || call.isAccepted) {
      throw new Error('Appel introuvable');
    }
    call.isAccepted = true;
    return call;
  }

  endCall(call) {
    this.callsById.delete(call.callId);
    this.callIdsByClientId.delete(call.callerClientId);
    this.callIdsByClientId.delete(call.calleeClientId);
  }

  isInAcceptedCallWith(clientId, peerClientId) {
    const call = this.findCallOfClient(clientId);
    return Boolean(call?.isAccepted) && getPeerClientId(call, clientId) === peerClientId;
  }
}

export function getPeerClientId(call, clientId) {
  return call.callerClientId === clientId ? call.calleeClientId : call.callerClientId;
}
