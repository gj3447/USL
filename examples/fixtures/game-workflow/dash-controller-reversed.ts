// Deliberately incorrect for the semantic-contract scenario: it permits air dashes.
export const dashCooldownSeconds = 0.35

export const canDash = (_grounded: boolean, cooldownRemaining: number) =>
  cooldownRemaining <= 0
