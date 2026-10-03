/**
 * Phase 1C blocks of the admin order card (docs/phase-1c-implementation.md decision С26): claims
 * with their texts and photos, installation bookings, order photos and the 1C buttons of
 * availableStaffActions1C (the same as in the seller bot), as the owner.
 */
import {
  loadBookingsView,
  loadClaimsView,
  loadOrderPhotos,
  loadStaffActions1C,
  type BookingView,
  type ClaimView,
  type EngineDeps,
  type OrderPhotoView,
  type StaffActionView1C,
} from '@detaly/orders';

export interface AdminOrder1C {
  /** Oldest first, with the client's text, the answer and the owner's reason (admin only). */
  claims: ClaimView[];
  bookings: BookingView[];
  /** Packaging, handover and return photos. */
  photos: OrderPhotoView[];
  actions: StaffActionView1C[];
}

export async function loadAdminOrder1C(
  deps: EngineDeps,
  orderId: string,
): Promise<AdminOrder1C | null> {
  const [claims, bookings, photos, actions] = await Promise.all([
    loadClaimsView(deps.db, orderId, { texts: true }),
    loadBookingsView(deps.db, orderId),
    loadOrderPhotos(deps.db, orderId, ['packaging', 'handover', 'return']),
    loadStaffActions1C(deps, orderId, 'owner'),
  ]);
  if (actions === null) return null;
  return { claims, bookings, photos, actions };
}
