// Party fields that must be blank when a new Labtest stay is saved.
export const blankPartyFields = Object.freeze(['taid1', 'companyid', 'groupid', 'groupcompanyid', 'grouptaid', 'groupta2id', 'groupta3id',
  'bookingagency2id', 'bookingagency3id', 'bookingagencycontractid', 'ta1', 'company', 'companyname', 'groupname', 'araccountname',
  'bacontract', 'bookingagency2name', 'bookingagency3name', 'bookingagency1iatanumber', 'bookingagency2iatanumber',
  'bookingagency3iatanumber']);

// Saved stays must also have no A/R or guarantee-card IDs.
export const blankSavedPartyFields = Object.freeze([...blankPartyFields,
  'arprofileid', 'araccountid', 'guaranteecreditcardid', 'leaseguaranteecreditcardid']);
