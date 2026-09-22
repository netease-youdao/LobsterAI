export const EmployeeTab = { Catalog: 'catalog', Installed: 'installed', Teams: 'teams' } as const;
export type EmployeeTab = typeof EmployeeTab[keyof typeof EmployeeTab];
export const EmployeeTabLabels = {
  [EmployeeTab.Catalog]: 'digitalEmployeeCatalog',
  [EmployeeTab.Installed]: 'digitalEmployeeInstalled',
  [EmployeeTab.Teams]: 'expertTeams',
} as const;
export const EmployeeView = 'employees' as const;
