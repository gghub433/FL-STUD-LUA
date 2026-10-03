// The engine's side of WAM plugins (Web Audio Modules 2.0). A plugin is its own AudioWorklet node next to the
// engine node; the page wires it to one of 16 stereo "ports":
//   instrument - the plugin's sound comes back on input channels 2p, 2p+1 of the engine node, and the engine sends
//                the channel's notes straight to the plugin's processor (same AudioWorklet scope), one block ahead
//   effect     - the engine writes the track's signal to output 1, channels 2p, 2p+1, the plugin processes it and
//                its result comes back one block (128 frames) later on input channels 2p, 2p+1; the mixer's delay
//                compensation accounts for that block plus the plugin's own reported delay
// host.wam = { group, ports: Map(owner -> { port, instanceId, latency }) }; host.extIn / host.extOut are the engine
// node's input and output channel arrays for the current block (only in the AudioWorklet).
import { BLOCK } from './constants.js';

export const WAM_PORTS = 16;

export function wamState(host) {
  return host.wam || (host.wam = { group: null, ports: new Map() });
}

export function linkOf(host, owner) {
  const w = host.wam;
  return w && owner ? w.ports.get(owner) || null : null;
}

// the plugin's processor in this AudioWorklet scope, or null
export function processorOf(host, link) {
  const g = host.wam && host.wam.group;
  return g && link ? g.processors.get(link.instanceId) || null : null;
}

// events reach the plugin a block later, so they are stamped one block ahead to land at the same offset
export const eventTime = (host, sr) => ((host.evFrame || 0) + BLOCK) / sr;
