-- Deciders are chosen by capability (decisions A5). A request still waiting for a list of roles
-- (no named person, no capability) waits for the holders of approvals.decide instead. Idempotent:
-- it only touches pending rows that name no capability.
UPDATE app.approvals
SET approver_capability = 'approvals.decide'
WHERE approver_capability IS NULL
  AND approver_user_id IS NULL
  AND status = 'pending';
