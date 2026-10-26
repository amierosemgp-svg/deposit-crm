-- Staff leave: one record per leave, instead of a mark per day.
--
-- The Leave sheet (23 Oct) is now where days off are told: From–To, the CS,
-- MC / annual / emergency / other, told or not, and why. Attendance reads it
-- the way it read staff_day_marks — every day a leave covers is a day off,
-- told or not as the leave says, even a day with time on the clock (half a day
-- then emergency leave counts as a whole day off).
--
-- staff_day_marks is replaced. It never reached live; any marks are copied
-- over (one single-day leave each) before it is dropped.

CREATE TYPE staff_leave_kind AS ENUM ('mc', 'annual', 'emergency', 'other');
CREATE TYPE staff_leave_status AS ENUM ('active', 'void');

CREATE TABLE staff_leaves (
  leave_id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(user_id),
  company_entity_id integer NOT NULL REFERENCES entities(entity_id),
  from_day varchar(10) NOT NULL,
  to_day varchar(10) NOT NULL,
  kind staff_leave_kind NOT NULL,
  notified boolean NOT NULL,
  reason varchar(200) NOT NULL,
  status staff_leave_status NOT NULL DEFAULT 'active',
  voided_at timestamptz,
  voided_by_user_id integer REFERENCES users(user_id),
  recorded_by_user_id integer NOT NULL REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_day >= from_day)
);
CREATE INDEX staff_leaves_user_days ON staff_leaves (user_id, from_day, to_day);

INSERT INTO staff_leaves (user_id, company_entity_id, from_day, to_day, kind, notified, reason, recorded_by_user_id, created_at)
SELECT m.user_id, e.parent_entity_id, m.day, m.day, 'other', m.mark = 'notified',
       coalesce(m.note, 'Marked day by day'), coalesce(m.marked_by_user_id, m.user_id), m.marked_at
FROM staff_day_marks m
JOIN users u ON u.user_id = m.user_id
JOIN entities e ON e.entity_id = u.entity_id
WHERE e.parent_entity_id IS NOT NULL;

DROP TABLE staff_day_marks;
DROP TYPE staff_day_mark;
