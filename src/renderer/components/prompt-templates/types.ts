// Variable types (v1 implements text and select, extensible for future types)
export type TemplateVariableType = 'text' | 'select';

export interface TemplateVariable {
  name: string;
  type: TemplateVariableType;
  label?: string;
  defaultValue?: string;
  options?: string[];
}

export interface PromptTemplate {
  id: string;
  title: string;
  content: string;
  description?: string;
  category?: string;
  variables: TemplateVariable[];
  isStarred: boolean;
  usedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTemplateInput {
  title: string;
  content: string;
  description?: string;
  category?: string;
  variables: TemplateVariable[];
}

export interface UpdateTemplateInput extends Partial<CreateTemplateInput> {
  isStarred?: boolean;
}

export interface TemplateListQuery {
  search?: string;
  category?: string;
}
