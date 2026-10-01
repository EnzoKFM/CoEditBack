import { beforeEach, describe, expect, it } from 'vitest';
import {
  AudioCallRegistry,
  MAX_CALL_CAMERAS,
  MAX_CALL_MEMBERS,
  listOtherParticipants,
} from '../src/collaboration/audioCallRegistry.js';

let registry;

beforeEach(() => {
  registry = new AudioCallRegistry();
});

function startAcceptedCall(callerClientId, calleeClientId) {
  const call = registry.inviteToCall({ inviterClientId: callerClientId, inviteeClientId: calleeClientId });
  registry.acceptCall(call.callId, calleeClientId);
  return call;
}

function fillCallWithParticipants(call, participantCount) {
  for (let participantNumber = call.participantClientIds.size; participantNumber < participantCount; participantNumber += 1) {
    const participantClientId = `participant-${participantNumber}`;
    registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: participantClientId });
    registry.acceptCall(call.callId, participantClientId);
  }
}

describe('invitations', () => {
  it("crée un appel avec l'appelant participant et l'invité en attente", () => {
    const call = registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'bob' });

    expect([...call.participantClientIds]).toEqual(['alice']);
    expect([...call.invitedClientIds]).toEqual(['bob']);
    expect(registry.findCallOfClient('bob')).toBe(call);
  });

  it('refuse de s appeler soi-même', () => {
    expect(() => registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'alice' })).toThrow(
      "Impossible de s'appeler soi-même",
    );
  });

  it('refuse un correspondant déjà en appel', () => {
    startAcceptedCall('alice', 'bob');

    expect(() => registry.inviteToCall({ inviterClientId: 'carla', inviteeClientId: 'bob' })).toThrow(
      'Correspondant déjà en appel',
    );
  });

  it("refuse l'invitation d'une personne dont l'appel entrant n'est pas accepté", () => {
    registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'bob' });

    expect(() => registry.inviteToCall({ inviterClientId: 'bob', inviteeClientId: 'carla' })).toThrow(
      'Vous êtes déjà en appel',
    );
  });

  it('ajoute un participant accepté à son appel et le retrouve par identifiant', () => {
    const call = startAcceptedCall('alice', 'bob');
    const sameCall = registry.inviteToCall({ inviterClientId: 'bob', inviteeClientId: 'carla' });

    expect(sameCall.callId).toBe(call.callId);
    expect(listOtherParticipants(call, 'alice')).toEqual(['bob']);
  });

  it("refuse d'accepter un appel inconnu ou non destiné au client", () => {
    const call = registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'bob' });

    expect(() => registry.acceptCall('inconnu', 'bob')).toThrow('Appel introuvable');
    expect(() => registry.acceptCall(call.callId, 'carla')).toThrow('Appel introuvable');
  });

  it(`refuse une invitation au-delà de ${MAX_CALL_MEMBERS} personnes, invitations en attente comprises`, () => {
    const call = startAcceptedCall('alice', 'bob');
    fillCallWithParticipants(call, MAX_CALL_MEMBERS - 1);
    registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'dernier-invite' });

    expect(() => registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'en-trop' })).toThrow(
      `L'appel est complet (${MAX_CALL_MEMBERS} personnes maximum)`,
    );
  });
});

describe('caméras', () => {
  it(`refuse une septième caméra mais laisse éteindre et rallumer`, () => {
    const call = startAcceptedCall('alice', 'bob');
    fillCallWithParticipants(call, MAX_CALL_CAMERAS + 1);
    const participantClientIds = [...call.participantClientIds];
    for (const participantClientId of participantClientIds.slice(0, MAX_CALL_CAMERAS)) {
      registry.setCamera(call, participantClientId, true);
    }
    const blockedClientId = participantClientIds[MAX_CALL_CAMERAS];

    expect(() => registry.setCamera(call, blockedClientId, true)).toThrow(
      `${MAX_CALL_CAMERAS} caméras sont déjà allumées dans cet appel`,
    );
    registry.setCamera(call, participantClientIds[0], true);
    registry.setCamera(call, participantClientIds[0], false);
    registry.setCamera(call, blockedClientId, true);
    expect(call.cameraClientIds.has(blockedClientId)).toBe(true);
    expect(call.cameraClientIds.size).toBe(MAX_CALL_CAMERAS);
  });
});

describe('départs et fin d appel', () => {
  it("garde l'appel quand il reste deux participants et retire la caméra de celui qui part", () => {
    const call = startAcceptedCall('alice', 'bob');
    registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'carla' });
    registry.acceptCall(call.callId, 'carla');
    registry.setCamera(call, 'carla', true);

    const departure = registry.leaveCall(call, 'carla');

    expect(departure).toEqual({ wasInvited: false, isEnded: false });
    expect(call.cameraClientIds.has('carla')).toBe(false);
    expect(registry.findCallOfClient('carla')).toBeNull();
  });

  it("termine l'appel quand il ne reste qu'un participant sans invitation en attente", () => {
    const call = startAcceptedCall('alice', 'bob');

    const departure = registry.leaveCall(call, 'bob');

    expect(departure.isEnded).toBe(true);
    expect(registry.findCallOfClient('alice')).toBeNull();
    expect(registry.callsById.size).toBe(0);
  });

  it("signale un refus d'invitation et termine l'appel s'il ne reste que l'appelant", () => {
    const call = registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'bob' });

    const departure = registry.leaveCall(call, 'bob');

    expect(departure).toEqual({ wasInvited: true, isEnded: true });
    expect(registry.findCallOfClient('alice')).toBeNull();
  });

  it("garde l'appel quand l'invité refuse mais qu'une autre invitation reste en attente", () => {
    const call = startAcceptedCall('alice', 'bob');
    registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'carla' });
    registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'david' });

    const departure = registry.leaveCall(call, 'carla');

    expect(departure).toEqual({ wasInvited: true, isEnded: false });
    expect(call.invitedClientIds.has('david')).toBe(true);
  });
});

describe('signalisation', () => {
  it('autorise le signal uniquement entre participants acceptés du même appel', () => {
    startAcceptedCall('alice', 'bob');
    registry.inviteToCall({ inviterClientId: 'alice', inviteeClientId: 'carla' });

    expect(registry.isInAcceptedCallWith('alice', 'bob')).toBe(true);
    expect(registry.isInAcceptedCallWith('alice', 'carla')).toBe(false);
    expect(registry.isInAcceptedCallWith('alice', 'alice')).toBe(false);
    expect(registry.isInAcceptedCallWith('alice', 'inconnu')).toBe(false);
    expect(registry.isInAcceptedCallWith('inconnu', 'alice')).toBe(false);
  });
});
