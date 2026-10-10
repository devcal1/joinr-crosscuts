DELETE FROM day_flags WHERE week_row_id NOT IN (SELECT id FROM week_rows);
