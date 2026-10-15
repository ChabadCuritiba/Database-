export function audit(db, user, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
    user?.id ?? null,
    action,
    entity ?? null,
    entityId ?? null,
    details === undefined ? null : typeof details === 'string' ? details : JSON.stringify(details),
  );
}
