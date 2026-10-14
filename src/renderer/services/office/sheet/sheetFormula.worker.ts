import { LocaleType, Univer } from '@univerjs/core';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRPCWorkerThreadPlugin } from '@univerjs/rpc';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import { UniverRemoteSheetsFormulaPlugin } from '@univerjs/sheets-formula';

/**
 * The editor's formula engine, off the grid's thread: Univer rebuilds its dependency trees on every
 * calculation, which takes a noticeable pause on workbooks with tens of thousands of formulas. The
 * editor's instance syncs the workbook and formula-related mutations here and applies the results.
 * Filters are loaded too, so SUBTOTAL and AGGREGATE skip the rows they hide.
 */
const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} } });
univer.registerPlugin(UniverSheetsPlugin, { onlyRegisterFormulaRelatedMutations: true });
univer.registerPlugin(UniverFormulaEnginePlugin);
univer.registerPlugin(UniverRPCWorkerThreadPlugin);
univer.registerPlugin(UniverRemoteSheetsFormulaPlugin);
univer.registerPlugin(UniverSheetsFilterPlugin);
