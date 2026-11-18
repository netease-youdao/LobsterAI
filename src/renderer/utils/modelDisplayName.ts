/** Hide the internal provider suffix without changing the model's routing ID. */
export const formatModelDisplayName = (model: string): string => model.replace(/-YoudaoInner$/i, '');
