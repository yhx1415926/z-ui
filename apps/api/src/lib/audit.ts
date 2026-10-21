import type { Context } from 'hono';
import { auditLog } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { newId } from './id.ts';

export type AuditAction =
  | 'login.success'
  | 'login.failure'
  | 'login.locked'
  | 'logout'
  | 'step_up'
  | 'passkey.add'
  | 'passkey.remove'
  | 'password.change'
  | 'totp.rebind'
  | 'recovery.regenerate'
  | 'recovery.used'
  | 'session.revoke'
  | 'invite.create'
  | 'invite.revoke'
  | 'invite.accept'
  | 'user.update'
  | 'card.reveal'
  | 'card.reveal_cvv'
  | 'config.save';

export async function audit(
  c: Context<AppBindings>,
  action: AuditAction,
  detail: Record<string, unknown> | null = null,
  userId: string | null = c.get('user')?.id ?? null,
) {
  await c.var.deps.db.insert(auditLog).values({
    id: newId(),
    userId,
    action,
    detail,
    ip: c.var.ip,
    createdAt: c.var.deps.now(),
  });
}
