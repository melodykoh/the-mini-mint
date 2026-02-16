-- Fix RLS infinite recursion on admin_users table.
-- The admin_only policy on admin_users references admin_users itself,
-- causing infinite recursion. Replace with a direct auth.uid() check.

DROP POLICY IF EXISTS "admin_only" ON admin_users;

CREATE POLICY "self_check" ON admin_users
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
