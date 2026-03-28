# Firestore rules for Add members (shared workspaces)

To allow adding members by email and letting them read/write the same workspace, add or merge the following in Firebase Console → Firestore → Rules.

## 1. Collection `userByEmail`

- **Read**: any authenticated user (so we can resolve email → uid when adding a member).
- **Write**: only the user can set their own email mapping (doc.uid == request.auth.uid).

```
match /userByEmail/{email} {
  allow read: if request.auth != null;
  allow create, update: if request.auth != null && request.resource.data.uid == request.auth.uid;
  allow delete: if false;
}
```

## 2. Shared workspaces (member’s copy)

Members get a doc in `users/{memberUid}/sharedWorkspaces/{ownerUid_workspaceId}`. Only that user should read/write their own `sharedWorkspaces` subcollection (your existing `users/{userId}/...` rules may already allow this).

## 3. Owner’s workspace data (so members can read/write)

Members must be able to read and write `users/{ownerUid}/workspaces/{workspaceId}/...` when they have been added. For example, if your current rules for workspaces look like:

```
match /users/{userId}/workspaces/{workspaceId}/{doc=**} {
  allow read, write: if request.auth.uid == userId;
}
```

Replace or add a rule so that **either** the user is the owner **or** they have the corresponding shared workspace doc:

```
match /users/{userId}/workspaces/{workspaceId}/{doc=**} {
  allow read, write: if request.auth.uid == userId
    || exists(/databases/$(database)/documents/users/$(request.auth.uid)/sharedWorkspaces/$(userId)_$(workspaceId));
}
```

This allows:
- The owner: full access.
- A member: access only if `users/{memberUid}/sharedWorkspaces/{ownerUid}_{workspaceId}` exists.

After updating, publish the rules in the Firebase Console.
