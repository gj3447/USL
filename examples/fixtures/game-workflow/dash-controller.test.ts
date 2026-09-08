import { canDash, dashCooldownSeconds } from "./dash-controller.js"

if (dashCooldownSeconds !== 0.35) throw new Error("dash cooldown changed")
if (canDash(false, 0)) throw new Error("air dash must be rejected")
if (!canDash(true, 0)) throw new Error("grounded dash must be allowed")
