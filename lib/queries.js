/**
 * lib/queries.js
 * Supabase geospatial / scheduling nurse-matching queries.
 *
 * findAvailableNurses:
 *   - Fetches active nurses matching the requested service (speciality) and
 *     geo (city keyword and/or 6-digit PIN from the new nurses.pincode column).
 *   - Excludes nurses already assigned to a booking in the same time slot
 *     (concurrent booking guard).
 *   - Returns up to MAX_CANDIDATES nurses to limit dispatch email volume.
 */

const MAX_CANDIDATES = 5;
const PIN_RE = /\b\d{6}\b/;

/**
 * Find active nurses available for a given booking.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Object} params
 * @param {string} params.location  - Free-text city / area / pin code from booking.
 * @param {string} params.service   - Requested service type (e.g. "Elder Care").
 * @param {string} [params.date]    - ISO date string for conflict exclusion.
 * @param {string} [params.time]    - Time slot string for conflict exclusion.
 * @returns {Promise<Array<{id, first_name, last_name, email, phone}>>}
 */
export async function findAvailableNurses(supabase, { location, service, date, time }) {
  // Step 1: Fetch all active nurses matching service + geo (city / pincode).
  const locationKeyword = (location || '').split(',')[0].trim(); // Use city/first-segment
  const pinMatch = String(location || '').match(PIN_RE);
  const pin = pinMatch ? pinMatch[0] : null;

  const filters = [];
  if (service) filters.push(`speciality.ilike.%${service}%`);
  if (locationKeyword) filters.push(`city.ilike.%${locationKeyword}%`);
  if (pin) filters.push(`pincode.ilike.%${pin}%`);

  const { data: candidates, error } = await supabase
    .from('nurses')
    .select('id, first_name, last_name, email, phone, speciality, city, pincode')
    .eq('status', 'active')
    .not('email', 'is', null)
    .or(filters.join(',') || 'status.eq.active') // fallback: all active nurses
    .limit(MAX_CANDIDATES * 3); // Over-fetch before conflict filtering

  if (error) throw new Error(`[queries] Nurse lookup failed: ${error.message}`);
  if (!candidates || candidates.length === 0) return [];

  // Step 2: If date + time provided, exclude nurses already assigned to a
  // confirmed/assigned booking in the same slot (time-conflict guard).
  if (date && time) {
    const nurseIds = candidates.map((n) => n.id);

    const { data: conflicted } = await supabase
      .from('bookings')
      .select('nurse_id')
      .in('nurse_id', nurseIds)
      .eq('scheduled_date', date)
      .eq('scheduled_time', time)
      .in('status', ['assigned', 'confirmed', 'in_progress']);

    const conflictedIds = new Set((conflicted || []).map((r) => r.nurse_id));
    const available = candidates.filter((n) => !conflictedIds.has(n.id));
    return available.slice(0, MAX_CANDIDATES);
  }

  return candidates.slice(0, MAX_CANDIDATES);
}
