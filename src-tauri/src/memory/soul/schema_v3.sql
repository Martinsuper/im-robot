ALTER TABLE soul_control ADD COLUMN mood_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mood_enabled IN (0,1));
ALTER TABLE soul_control ADD COLUMN evolution_enabled INTEGER NOT NULL DEFAULT 0 CHECK(evolution_enabled IN (0,1));
