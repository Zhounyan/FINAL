# Backup & Restore — operations guide

Admin only. Owner and Staff cannot see the page, and the server refuses them
(the Edge Function returns 403; row-level security hides the backup tables).

## What a backup contains

A backup is a ZIP named `InvportIQ_<Full|Weekly|PreRestore>_Backup_YYYY-MM-DD_HHmm.zip`:

| Path | Contents |
|---|---|
| `metadata.json` | App name and version, backup type, creation time, creator, row count per table, file count, schema signature, and a SHA-256 checksum for every file in the archive |
| `database/<table>.json` | Every row of every application table. Today that is 12 tables: `activity_logs`, `auth_lockouts`, `categories`, `customers`, `products`, `profiles`, `sale_items`, `sales`, `setup_state`, `stock_movements`, `suppliers`, `system_settings`. A table added by a later migration is included automatically. |
| `schema/schema.json` | Columns, constraints, indexes, triggers, RLS policies and functions, used for the compatibility check |
| `auth/users.json` | Login accounts (id, email, created at), used to check accounts. **No passwords or password hashes.** |
| `files/<bucket>/<path>` | Profile photos and any other files in app storage |
| `README.txt` | A plain-language description of the archive |

**Not included, by design:** passwords and sessions (Supabase Auth keeps these; they are covered by Supabase's own daily database backups), secrets and keys, and source code (kept in GitHub).

## How it works

* **Manual backup:** Backup & Restore → **Create backup**. The stages are Preparing → Exporting database → Collecting files → Creating archive → Verifying → Saving.
* **Automatic weekly backup:** **Supabase Cron** (`pg_cron`) calls the `backup-scheduler` Edge Function every hour at minute 7. The function checks the schedule in the store's time zone (`system_settings.timezone`, default Asia/Manila; default slot Sunday 12:00 AM) and runs the backup once the slot has passed. No browser needs to be open.
  * A unique index lets only one backup run per weekly slot. Duplicate cron calls get `already_done` or `in_progress`.
  * A failed run is retried at the next hourly check, up to 3 attempts per slot. Admins see a notification when the latest automatic backup failed.
* **Storage:** each backup is stored in the private `backups` Storage bucket, encrypted with AES-256-GCM. The SHA-256 of the plain ZIP is recorded, and the stored copy is read back and verified before the run is marked successful.
* **Retention:** the newest **12 successful weekly backups** are kept; older ones are deleted. Failed runs never count. Manual and uploaded backups are kept until an Admin deletes them, and the newest 5 pre-restore safety backups are kept. The only remaining valid backup cannot be deleted.

## Restoring

1. On the backup's row, click **Restore** and type `RESTORE` to confirm.
2. The server then runs these steps in order:
   1. It locks out other restores and backups.
   2. It re-verifies every checksum and checks compatibility (format version, the table set and the column types).
   3. It creates a **pre-restore safety backup** of the current data.
   4. It replaces every table inside **one database transaction**, with constraint, foreign-key and stock-ledger checks. If any check fails, the whole transaction is rolled back and the current data is left untouched.
   5. It restores the stored files and compares row counts with the archive.
   6. It records the restore in the activity log.
3. After a restore, sign-in accounts whose profile was not in the backup are listed in the result. Passwords are never changed by a restore.

To roll back a restore, restore the **Pre-restore safety** backup it created.

**Upload:** **Upload backup** accepts a ZIP downloaded from INVPORTIQ, up to 100 MB. The upload is rejected if any checksum fails, a path is unsafe, or the format is not compatible. Accepted uploads appear as *Uploaded* and can be restored like any other backup.

## Deploying to the hosted project (one time)

1. **SQL Editor:** run `supabase/migrations/20261112001000_backup_restore.sql`.
2. **Database → Extensions:** enable **pg_cron** and **pg_net**.
3. **Deploy the functions:**
   ```bash
   npx supabase functions deploy backup-admin backup-scheduler --project-ref <ref> --use-api
   ```
4. **Recommended:** set your own encryption key. Keep a copy somewhere safe, because backups cannot be decrypted without it.
   ```bash
   npx supabase secrets set BACKUP_ENCRYPTION_KEY=<64 hex characters> --project-ref <ref>
   ```
   If you do not set it, the key is derived from the project's service-role key. Rotating that key would then make older *stored* copies unreadable. Downloaded copies are plain ZIPs and are not affected.
5. In the app, open **Backup & Restore → Activate scheduler**. The status should change to *Active*.

## Disaster-recovery checklist

* **Download a backup regularly** and keep it off-site. Stored backups live in the same Supabase project as the data, so they are not a separate failure domain.
* **Losing the whole project:**
  1. Create a new project.
  2. Apply all migrations.
  3. Deploy the functions and set the secrets.
  4. Run the one-time setup.
  5. Upload your latest downloaded ZIP and restore it.
  6. Users whose login accounts no longer exist must be re-created by the Admin. The result lists them.
* **Practise a restore in a separate test project.** Never practise against live production data.
