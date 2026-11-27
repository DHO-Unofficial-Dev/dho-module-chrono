// SPDX-License-Identifier: MPL-2.0
export function suggestedTimerKind(item) {
  return /타롯|타로(?:\s*카드)?|아르카나/.test(`${item?.name ?? ''} ${item?.description ?? ''}`) ? 'tarot' : 'item';
}
