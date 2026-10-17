// Single source of truth for permission strings.
const PERMISSIONS = {
  READ_ONLY: 'ReadOnly',
  FULL_ACC: 'FullAcc',
  WRITE_DELETE_EDIT_SELF_ADDS: 'WriteDeleteEditSelfAdds',
  NO_ACCESS: 'NoAccess',
};

// Read-only users can view products and users, but cannot change anything.
function canViewUsers(permission) {
  return [PERMISSIONS.READ_ONLY, PERMISSIONS.FULL_ACC, PERMISSIONS.WRITE_DELETE_EDIT_SELF_ADDS].includes(permission);
}

// Full access users can view and manage everything.
function canViewProducts(permission) {
  return [PERMISSIONS.READ_ONLY, PERMISSIONS.FULL_ACC, PERMISSIONS.WRITE_DELETE_EDIT_SELF_ADDS].includes(permission);
}

// Only full-access users and self-add users can create products.
function canCreateProducts(permission) {
  return [PERMISSIONS.FULL_ACC, PERMISSIONS.WRITE_DELETE_EDIT_SELF_ADDS].includes(permission);
}

// Full access can modify any product; self-add users can modify only products they created.
function canModifyProduct(permission, user, product) {
  if (permission === PERMISSIONS.FULL_ACC) return true;
  if (permission !== PERMISSIONS.WRITE_DELETE_EDIT_SELF_ADDS) return false;

  const ownerId = product?.created_by;
  return ownerId !== null && ownerId !== undefined && Number(ownerId) === Number(user?.id);
}

module.exports = {
  PERMISSIONS,
  canViewUsers,
  canViewProducts,
  canCreateProducts,
  canModifyProduct,
};
