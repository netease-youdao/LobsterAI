# SQLite Backup Performance Test

本目录用于 SQLite 备份与恢复相关的性能压测。  
This directory contains utilities and notes for SQLite backup and recovery performance testing.

## Files

- `generate-large-db.cjs`: 批量向现有数据库写入大体量测试数据。  
  Bulk-loads large synthetic data into an existing database.

## Test Goals

- 构造一个足够大的本地数据库，观察自动备份耗时与日志输出。  
  Build a large enough local database and observe automatic backup duration and logs.
- 验证“正常启动检查”和“每次启动强制备份”两种路径。  
  Validate both the normal startup check path and the forced-backup-on-every-startup path.
- 验证备份文件缺失或数据库损坏时，恢复逻辑是否符合预期。  
  Validate recovery behavior when the backup file is missing or the database is corrupted.

## Prerequisites

1. 确认系统可用 `sqlite3`。  
   Confirm that `sqlite3` is available in your shell.

   ```bash
   which sqlite3
   sqlite3 -version
   ```

2. 确认目标数据库路径。默认桌面版用户数据路径通常是：  
   Confirm the target database path. The default desktop user-data path is usually:

   ```bash
   ~/Library/Application\ Support/LobsterAI/lobsterai.sqlite
   ```

3. 建议先退出应用，避免写入测试数据时与正在运行的进程竞争数据库锁。  
   It is recommended to close the app before seeding data, to avoid lock contention with a running process.

## 1. Generate a Large Database

先使用脚本写入测试数据。  
First, generate enough data for backup performance testing.

### Example: medium-sized dataset

```bash
npm run test:sqlite-backup:seed -- \
  --db '/Users/jj.deng/Library/Application Support/LobsterAI/lobsterai.sqlite' \
  --sessions 10 \
  --messages-per-session 2000 \
  --payload-kb 8
```

### Example: larger dataset

```bash
npm run test:sqlite-backup:seed -- \
  --db '/Users/jj.deng/Library/Application Support/LobsterAI/lobsterai.sqlite' \
  --sessions 50 \
  --messages-per-session 10000 \
  --payload-kb 16
```

### Notes

- 脚本会向 `cowork_sessions` 和 `cowork_messages` 追加写入数据，不会清空原有数据。  
  The script appends data into `cowork_sessions` and `cowork_messages`; it does not wipe existing data.
- `payload-kb` 越大，单条消息越长，备份文件增长越快。  
  A larger `payload-kb` makes each message larger and grows the backup payload faster.
- 生成完成后，脚本会输出主库和 WAL 文件大小。  
  After completion, the script prints the main DB size and WAL size.

## 2. Enable Auto Backup in the App

打开应用设置，启用“自动备份与恢复”。  
Open the app settings and enable "Auto Backup and Recovery".

这是自动备份逻辑的前置条件。  
This is required before the automatic backup logic will run.

## 3. Force Backup on Every Startup for QA

如果 QA 需要每次启动都触发一次自动备份，可以设置环境变量：  
If QA needs an automatic backup on every startup, set this environment variable:

```bash
LOBSTERAI_SQLITE_BACKUP_ALWAYS_ON_STARTUP=1
```

支持的 truthy 值：`1`、`true`。  
Supported truthy values: `1`, `true`.

### Example: run in dev mode with forced startup backup

```bash
LOBSTERAI_SQLITE_BACKUP_ALWAYS_ON_STARTUP=1 npm run electron:dev
```

### What this does

- 启动时会跳过“距离上次备份是否已满 3 天”的限制，直接判定需要备份。  
  On startup, it bypasses the normal "has it been 3 days?" interval check and forces a backup.
- 该变量只影响自动备份时机，不影响恢复逻辑。  
  This variable only changes automatic backup timing; it does not change recovery behavior.

## 4. Observe Backup Logs

启动应用后，观察主进程日志。  
After the app starts, inspect the main-process logs.

重点关注这些日志：  
Focus on these log lines:

- `[SqliteBackup] Forced startup backup is enabled ...`
- `[SqliteBackup] Starting periodic backup to lobsterai-latest.sqlite`
- `[SqliteBackup] Backup progress: transferred X/Y pages, Z remaining`
- `[SqliteBackup] Completed periodic backup with 1 retained snapshot(s)`

如果没有设置强制环境变量，则启动时会先检查：  
Without the force env var, startup will first check:

- 备份文件是否存在  
  whether the backup file exists
- 距离上次成功备份是否已经超过 3 天  
  whether more than 3 days have passed since the last successful backup

## 5. Verify Backup Artifact

备份完成后，检查备份文件是否存在：  
After backup completes, verify that the backup file exists:

```bash
ls -lh ~/Library/Application\ Support/LobsterAI/backups/sqlite/snapshots/
```

当前单文件备份名为：  
The current single backup file is:

```text
lobsterai-latest.sqlite
```

## 6. Recovery Test

### Option A: backup file missing

删除备份文件，然后重新启动应用。  
Delete the backup file, then restart the app.

预期行为：  
Expected behavior:

- 启动检查会发现备份文件缺失  
  startup check notices the backup file is missing
- 自动触发一次补备份  
  an automatic replacement backup is triggered

### Option B: corrupt the main database

先确保已有有效备份，然后故意破坏主库。  
Make sure a valid backup exists first, then intentionally corrupt the main database.

示例：  
Example:

```bash
printf 'not-a-sqlite-db' > ~/Library/Application\ Support/LobsterAI/lobsterai.sqlite
```

然后启动应用。  
Then launch the app.

预期行为：  
Expected behavior:

- 主库打开失败  
  opening the main DB fails
- 应用尝试从最新备份恢复  
  the app attempts to restore from the latest backup
- 恢复成功后继续启动  
  startup continues after successful restore

## 7. Suggested QA Flow

建议 QA 按下面顺序走一轮：  
Suggested QA sequence:

1. 关闭应用。  
   Close the app.
2. 运行灌库脚本，构造大数据库。  
   Run the seeding script to build a large database.
3. 在应用中启用自动备份与恢复。  
   Enable auto backup and recovery in the app.
4. 使用 `LOBSTERAI_SQLITE_BACKUP_ALWAYS_ON_STARTUP=1` 启动应用。  
   Launch the app with `LOBSTERAI_SQLITE_BACKUP_ALWAYS_ON_STARTUP=1`.
5. 记录备份开始、进度、完成日志及耗时。  
   Record backup start, progress, completion logs, and duration.
6. 删除备份文件，重新启动，确认会立即补备份。  
   Delete the backup file, restart, and confirm a replacement backup is created immediately.
7. 破坏主库并重启，确认恢复逻辑可用。  
   Corrupt the main DB and restart to confirm recovery works.

## Safety Notes

- 不要在重要真实数据环境里做破坏性恢复测试。  
  Do not run destructive recovery tests against important real user data.
- 建议先手动拷贝一份用户数据库目录再做压测。  
  It is recommended to copy the user-data directory before running aggressive tests.
