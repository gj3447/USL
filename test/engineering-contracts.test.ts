import { test } from "node:test"
import { engineeringAdversarialCases } from "./engineering-adversarial-cases.js"

for (const entry of engineeringAdversarialCases) test(`engineering ${entry.id}: ${entry.description}`, entry.run)
