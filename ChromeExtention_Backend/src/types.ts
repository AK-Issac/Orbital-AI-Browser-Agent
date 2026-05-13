export interface DOMElement {
  id: string;
  tag: string;
  type?: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  href?: string;
  labelText?: string;
  formGroup?: string;
  currentValue?: string;
  isChecked?: boolean;
  options?: string;
}

export interface Action {
  actionType: 'click' | 'type' | 'upload';
  targetId: string;
  value: string | null;
}

export interface ActionPlan {
  thought: string;
  taskCompleted: boolean;
  actions: Action[];
}