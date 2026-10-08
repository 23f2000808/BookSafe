export {
  IllegalTransitionError,
  type TransitionMachine,
} from './errors';
export {
  SeatStatus,
  seatTransitions,
  canTransitionSeat,
  assertTransitionSeat,
} from './seat';
export {
  BookingStatus,
  bookingTransitions,
  canTransitionBooking,
  assertTransitionBooking,
} from './booking';
