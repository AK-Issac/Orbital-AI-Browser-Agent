export interface DOMElement {
  id: string;
  tag: string;
  type?: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
}

export interface Action {
  actionType: 'click' | 'type';
  targetId: string;
  value: string | null;
}

export interface ActionPlan {
  thought: string;
  taskCompleted: boolean;
  actions: Action[];
}
