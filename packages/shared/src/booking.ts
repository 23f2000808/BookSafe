import { IllegalTransitionError } from './errors';

export const BookingStatus = {
  HELD: 'HELD',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

export const bookingTransitions: ReadonlyArray<{
  from: BookingStatus;
  to: BookingStatus;
}> = [
  { from: BookingStatus.HELD, to: BookingStatus.PAYMENT_PENDING },
  { from: BookingStatus.HELD, to: BookingStatus.EXPIRED },
  { from: BookingStatus.HELD, to: BookingStatus.CANCELLED },
  { from: BookingStatus.PAYMENT_PENDING, to: BookingStatus.CONFIRMED },
  { from: BookingStatus.PAYMENT_PENDING, to: BookingStatus.FAILED },
  { from: BookingStatus.CONFIRMED, to: BookingStatus.CANCELLED },
];

export function canTransitionBooking(
  from: BookingStatus,
  to: BookingStatus,
): boolean {
  return bookingTransitions.some(
    (edge) => edge.from === from && edge.to === to,
  );
}

export function assertTransitionBooking(
  from: BookingStatus,
  to: BookingStatus,
): void {
  if (!canTransitionBooking(from, to)) {
    throw new IllegalTransitionError('booking', from, to);
  }
}
