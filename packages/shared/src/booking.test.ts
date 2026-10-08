import {
  BookingStatus,
  type BookingStatus as BookingStatusValue,
  assertTransitionBooking,
  bookingTransitions,
  canTransitionBooking,
} from './booking';
import { IllegalTransitionError } from './errors';

const statuses: BookingStatusValue[] = [
  BookingStatus.HELD,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.FAILED,
  BookingStatus.EXPIRED,
  BookingStatus.CANCELLED,
];

const legalPairs: ReadonlyArray<
  readonly [BookingStatusValue, BookingStatusValue]
> = [
  [BookingStatus.HELD, BookingStatus.PAYMENT_PENDING],
  [BookingStatus.HELD, BookingStatus.EXPIRED],
  [BookingStatus.HELD, BookingStatus.CANCELLED],
  [BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED],
  [BookingStatus.PAYMENT_PENDING, BookingStatus.FAILED],
  [BookingStatus.CONFIRMED, BookingStatus.CANCELLED],
];

const terminals: BookingStatusValue[] = [
  BookingStatus.EXPIRED,
  BookingStatus.FAILED,
  BookingStatus.CANCELLED,
];

function isLegal(from: BookingStatusValue, to: BookingStatusValue): boolean {
  return legalPairs.some(([legalFrom, legalTo]) => {
    return legalFrom === from && legalTo === to;
  });
}

describe('booking transitions', () => {
  it('lists every booking status', () => {
    expect(statuses).toHaveLength(Object.keys(BookingStatus).length);
    expect(new Set(statuses)).toEqual(new Set(Object.values(BookingStatus)));
  });

  it('exports the spec transition table', () => {
    expect(bookingTransitions).toEqual(
      legalPairs.map(([from, to]) => ({ from, to })),
    );
  });

  it('gives terminal states no outgoing edge', () => {
    for (const from of terminals) {
      expect(legalPairs.some(([legalFrom]) => legalFrom === from)).toBe(false);
      expect(bookingTransitions.some((edge) => edge.from === from)).toBe(
        false,
      );
    }
  });

  for (const from of statuses) {
    for (const to of statuses) {
      const label = `${from} -> ${to}`;
      if (isLegal(from, to)) {
        it(`allows ${label}`, () => {
          expect(canTransitionBooking(from, to)).toBe(true);
          expect(() => assertTransitionBooking(from, to)).not.toThrow();
        });
      } else {
        it(`rejects ${label}`, () => {
          expect(canTransitionBooking(from, to)).toBe(false);
          try {
            assertTransitionBooking(from, to);
            fail('expected IllegalTransitionError');
          } catch (error) {
            expect(error).toBeInstanceOf(IllegalTransitionError);
            if (error instanceof IllegalTransitionError) {
              expect(error.machine).toBe('booking');
              expect(error.from).toBe(from);
              expect(error.to).toBe(to);
            }
          }
        });
      }
    }
  }
});
