export const dashCooldownSeconds = 0.35

export const canDash = (grounded: boolean, cooldownRemaining: number) =>
  grounded && cooldownRemaining <= 0
