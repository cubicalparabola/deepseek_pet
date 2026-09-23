/**
 * 状态工具（无依赖，供各模块共用，避免循环依赖）。
 */

import { PET_STATES, type PetState } from '../../shared/state-types';

export function isPetState(value: unknown): value is PetState {
  return typeof value === 'string' && (PET_STATES as readonly string[]).includes(value);
}

export function assertPetState(value: unknown, fallback: PetState = 'IDLE'): PetState {
  return isPetState(value) ? value : fallback;
}
