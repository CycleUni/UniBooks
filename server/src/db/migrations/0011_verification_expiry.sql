-- A campus verification now lasts two years. Rows from before had no expiry:
-- each gets two years from when it was verified (manual ones included), but
-- never less than 30 days from now, so nobody lapses the day this ships and
-- an older row lands straight in the 30-day renewal window.
UPDATE `region_verifications`
SET `expires_at` = max(
  strftime('%Y-%m-%dT%H:%M:%fZ', `verified_at`, '+2 years'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')
)
WHERE `expires_at` IS NULL;
