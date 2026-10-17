import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { KvoxAuth } from '@marinoscar/kvox-api/core';
import { KVOX_JOBS } from '@marinoscar/kvox-api/ports';

import { BACKUP_EXPORT_JOB, BACKUP_RESTORE_JOB, BACKUP_SUBJECT } from './backup/backup-jobs.js';
import type { PgTableJobs } from './ports/pg-table-jobs.js';

// =============================================================================
// /api/desktop/backup: the routes of the "Data and privacy" card (marinoscar/kvox#583)
// =============================================================================
//
//   POST /api/desktop/backup/export  { path }  -> { jobId }   enqueue an export
//   POST /api/desktop/backup/restore { path }  -> { jobId }   enqueue a restore
//   GET  /api/desktop/backup/jobs/:id          -> the job's status and error
//
// The path comes from the main process's native save/open dialog (the card asks
// the preload); the routes sit behind the per-launch token like every other.
// Host glue: the work is the jobs' (`backup/backup-jobs.ts`).
// =============================================================================

interface PathBody {
  path?: unknown;
}

function pathOf(body: PathBody | undefined, extension?: string): string {
  const path = typeof body?.path === 'string' ? body.path.trim() : '';
  if (path === '' || !isAbsolute(path)) throw new BadRequestException('path must be an absolute file path');
  if (extension && !path.toLowerCase().endsWith(extension)) return `${path}${extension}`;
  return path;
}

@Controller('desktop/backup')
export class DesktopDataController {
  constructor(@Inject(KVOX_JOBS) private readonly jobs: PgTableJobs) {}

  @Post('export')
  @HttpCode(202)
  @KvoxAuth()
  async export(@Body() body: PathBody): Promise<{ jobId: string }> {
    const queued = await this.jobs.enqueue({
      type: BACKUP_EXPORT_JOB,
      subjectType: BACKUP_SUBJECT,
      subjectId: randomUUID(),
      payload: { path: pathOf(body, '.kvoxbackup') },
      reason: 'user',
    });
    return { jobId: queued.id };
  }

  @Post('restore')
  @HttpCode(202)
  @KvoxAuth()
  async restore(@Body() body: PathBody): Promise<{ jobId: string }> {
    const queued = await this.jobs.enqueue({
      type: BACKUP_RESTORE_JOB,
      subjectType: BACKUP_SUBJECT,
      subjectId: randomUUID(),
      payload: { path: pathOf(body) },
      reason: 'user',
    });
    return { jobId: queued.id };
  }

  @Get('jobs/:id')
  @KvoxAuth()
  async job(@Param('id', ParseUUIDPipe) id: string) {
    const job = await this.jobs.describeJob(id);
    if (!job || (job.type !== BACKUP_EXPORT_JOB && job.type !== BACKUP_RESTORE_JOB)) throw new NotFoundException('There is no such job');
    return { id: job.id, status: job.status, error: job.lastError };
  }
}
