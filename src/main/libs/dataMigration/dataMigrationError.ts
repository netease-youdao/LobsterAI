import type { DataMigrationErrorCode } from '../../../shared/dataMigration/constants';

export class DataMigrationError extends Error {
  readonly code: DataMigrationErrorCode;

  constructor(code: DataMigrationErrorCode, message: string) {
    super(message);
    this.name = 'DataMigrationError';
    this.code = code;
  }
}

export const isDataMigrationError = (error: unknown): error is DataMigrationError =>
  error instanceof DataMigrationError;
