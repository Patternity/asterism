-- Reverse of 020. Dropping the tables takes their triggers with them, but the
-- function is independent and has to go explicitly.
DROP TRIGGER IF EXISTS tasks_refuse_in_trash ON tasks;

DROP TABLE IF EXISTS task_reports;

DROP TABLE IF EXISTS task_events;

DROP TABLE IF EXISTS task_input_requests;

DROP TABLE IF EXISTS task_requests;

DROP TABLE IF EXISTS task_runs;

DROP TABLE IF EXISTS task_plan_steps;

DROP TABLE IF EXISTS tasks;

DROP FUNCTION IF EXISTS refuse_task_work_in_trash ();
