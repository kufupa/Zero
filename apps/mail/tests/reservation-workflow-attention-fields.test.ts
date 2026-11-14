import { describe, expect, it } from 'vitest';
import { attentionFieldPath, inputFieldLabel } from '../lib/reservation-workflow/client';

const root = '/proposal/content/requests/quote-1';

describe('reservation workflow attention fields', () => {
  it('maps bare Quote party issues to mounted pickers', () => {
    expect(attentionFieldPath('organization_candidate_unverified', root))
      .toBe(`${root}/body/parties/organization`);
    expect(attentionFieldPath('bookingAgency_requires_staff_acceptance', root))
      .toBe(`${root}/body/parties/bookingAgency`);
  });

  it('maps extra and meal-plan blockers to editable controls', () => {
    expect(attentionFieldPath(`${root}/body/allocations/0/guest:existing_profile_selection_required`, root))
      .toBe(`${root}/body/allocations/0/guest/nativeSelectionRef`);
    expect(attentionFieldPath(`${root}/body/requestedMoney/0:allowance_requires_supported_staff_choice`, root))
      .toBe(`${root}/body/requestedMoney/0/staffAllowanceType`);
    expect(attentionFieldPath(`${root}/body/groups/0/mealPlan:native_meal_plan_code_required`, root))
      .toBe(`${root}/body/groups/0/ratePlan`);
  });

  it('maps quote group blockers to Add/Remove controls', () => {
    expect(attentionFieldPath(`${root}/body/groups:group_required`, root))
      .toBe(`${root}/body/groups`);
    expect(attentionFieldPath(`${root}/body/groups:native_quote_group_limit`, root))
      .toBe(`${root}/body/groups/0`);
    expect(attentionFieldPath(`${root}/body/groups:duplicate_group_id`, root))
      .toBe(`${root}/body/groups/0`);
    expect(attentionFieldPath(`${root}/body/groups/2/id:native_group_id_limit`, root))
      .toBe(`${root}/body/groups/2`);
  });

  it('uses action-oriented Review labels', () => {
    expect(inputFieldLabel(`${root}/body/requestedMoney:lunch_extra_price_required`))
      .toBe('lunch extra requested amount');
    expect(inputFieldLabel(`${root}/body/requestedMoney/0:allowance_requires_supported_staff_choice`))
      .toBe('Handle as for this extra');
    expect(inputFieldLabel(`${root}/body/groups/0/mealPlan:native_board_code_required`))
      .toBe('Rate Plan (sets Meal Plan)');
    expect(inputFieldLabel(`${root}/body/shared/guestOptIn:true_not_supported`))
      .toBe('Terms and Conditions');
    expect(inputFieldLabel(`${root}/body/groups:group_required`)).toBe('Add a room group');
    expect(inputFieldLabel(`${root}/body/groups:duplicate_group_id`)).toBe('Remove a duplicate room group');
    expect(inputFieldLabel(`${root}/body/groups:native_quote_group_limit`)).toBe('Remove a room group (max 8)');
    expect(inputFieldLabel(`${root}/body/groups/0/id:native_group_id_limit`)).toBe('Remove this room group (ID too long)');
    expect(inputFieldLabel(`${root}/confirmationReference`))
      .toBe('source confirmation (review email/PDF — no Create field)');
  });
});
