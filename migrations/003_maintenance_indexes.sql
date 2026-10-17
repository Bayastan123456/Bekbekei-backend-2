CREATE INDEX events_created_at ON events(created_at);
CREATE INDEX sessions_refresh_expires_at ON sessions(refresh_expires_at);
CREATE INDEX sessions_revoked_at ON sessions(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX otp_challenges_expires_at ON otp_challenges(expires_at);
CREATE INDEX jobs_completed_at ON jobs(completed_at) WHERE completed_at IS NOT NULL;
