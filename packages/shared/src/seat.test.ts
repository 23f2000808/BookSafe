import { IllegalTransitionError } from './errors';
import {
  SeatStatus,
  type SeatStatus as SeatStatusValue,
  assertTransitionSeat,
  canTransitionSeat,
  seatTransitions,
} from './seat';

const statuses: SeatStatusValue[] = [
  SeatStatus.AVAILABLE,
  SeatStatus.HELD,
  SeatStatus.BOOKED,
];

const legalPairs: ReadonlyArray<readonly [SeatStatusValue, SeatStatusValue]> = [
  [SeatStatus.AVAILABLE, SeatStatus.HELD],
  [SeatStatus.HELD, SeatStatus.AVAILABLE],
  [SeatStatus.HELD, SeatStatus.BOOKED],
  [SeatStatus.BOOKED, SeatStatus.AVAILABLE],
];

function isLegal(from: SeatStatusValue, to: SeatStatusValue): boolean {
  return legalPairs.some(([legalFrom, legalTo]) => {
    return legalFrom === from && legalTo === to;
  });
}

describe('seat transitions', () => {
  it('lists every seat status', () => {
    expect(statuses).toHaveLength(Object.keys(SeatStatus).length);
    expect(new Set(statuses)).toEqual(new Set(Object.values(SeatStatus)));
  });

  it('exports the spec transition table', () => {
    expect(seatTransitions).toEqual(
      legalPairs.map(([from, to]) => ({ from, to })),
    );
  });

  for (const from of statuses) {
    for (const to of statuses) {
      const label = `${from} -> ${to}`;
      if (isLegal(from, to)) {
        it(`allows ${label}`, () => {
          expect(canTransitionSeat(from, to)).toBe(true);
          expect(() => assertTransitionSeat(from, to)).not.toThrow();
        });
      } else {
        it(`rejects ${label}`, () => {
          expect(canTransitionSeat(from, to)).toBe(false);
          try {
            assertTransitionSeat(from, to);
            fail('expected IllegalTransitionError');
          } catch (error) {
            expect(error).toBeInstanceOf(IllegalTransitionError);
            if (error instanceof IllegalTransitionError) {
              expect(error.machine).toBe('seat');
              expect(error.from).toBe(from);
              expect(error.to).toBe(to);
            }
          }
        });
      }
    }
  }
});
