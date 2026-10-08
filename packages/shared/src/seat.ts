import { IllegalTransitionError } from './errors';

export const SeatStatus = {
  AVAILABLE: 'AVAILABLE',
  HELD: 'HELD',
  BOOKED: 'BOOKED',
} as const;

export type SeatStatus = (typeof SeatStatus)[keyof typeof SeatStatus];

export const seatTransitions: ReadonlyArray<{
  from: SeatStatus;
  to: SeatStatus;
}> = [
  { from: SeatStatus.AVAILABLE, to: SeatStatus.HELD },
  { from: SeatStatus.HELD, to: SeatStatus.AVAILABLE },
  { from: SeatStatus.HELD, to: SeatStatus.BOOKED },
  { from: SeatStatus.BOOKED, to: SeatStatus.AVAILABLE },
];

export function canTransitionSeat(from: SeatStatus, to: SeatStatus): boolean {
  return seatTransitions.some((edge) => edge.from === from && edge.to === to);
}

export function assertTransitionSeat(from: SeatStatus, to: SeatStatus): void {
  if (!canTransitionSeat(from, to)) {
    throw new IllegalTransitionError('seat', from, to);
  }
}
