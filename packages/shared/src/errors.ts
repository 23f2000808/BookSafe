export type TransitionMachine = 'seat' | 'booking';

export class IllegalTransitionError extends Error {
  readonly machine: TransitionMachine;
  readonly from: string;
  readonly to: string;

  constructor(machine: TransitionMachine, from: string, to: string) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}
