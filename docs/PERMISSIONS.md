# GHANIPUR — Permission Matrix (§31)

Permissions are granular strings. Roles map to default permission sets; individual
users may be granted extra permissions via `User.permissions[]`. One reusable
`authorize(...perms)` middleware enforces them.

## Roles
- `SUPER_ADMIN` — platform-wide, no shopId.
- `SHOP_ADMIN` — full control of own shop.
- `SHOP_STAFF` — day-to-day operations of own shop (no destructive/settings).
- `USER` — public/customer (future storefront account).

## Permission keys
```
SHOP_VIEW SHOP_UPDATE SHOP_CREATE SHOP_DELETE SHOP_APPROVE SHOP_SUSPEND
CATEGORY_VIEW CATEGORY_CREATE CATEGORY_UPDATE CATEGORY_DELETE
PRODUCT_VIEW PRODUCT_CREATE PRODUCT_UPDATE PRODUCT_DELETE
UNIT_MANAGE
INVENTORY_VIEW INVENTORY_ADJUST
SALE_VIEW SALE_CREATE SALE_REVERSE
CUSTOMER_VIEW CUSTOMER_CREATE CUSTOMER_UPDATE CUSTOMER_DELETE
LEDGER_VIEW
PAYMENT_VIEW PAYMENT_CREATE PAYMENT_REVERSE
DELIVERY_VIEW DELIVERY_MANAGE
EXPENSE_VIEW EXPENSE_CREATE
REPORT_VIEW
SETTINGS_VIEW SETTINGS_UPDATE
USER_MANAGE            (manage staff within a shop)
PLATFORM_MANAGE        (super-admin platform ops)
AUDIT_VIEW
IMPERSONATE_SHOP       (super-admin, audit-logged)
```

## Default mappings
| Permission group | SUPER_ADMIN | SHOP_ADMIN | SHOP_STAFF |
|---|:--:|:--:|:--:|
| SHOP_VIEW / UPDATE | ✔ (all) | ✔ (own) | view |
| SHOP_CREATE/DELETE/APPROVE/SUSPEND | ✔ | — | — |
| CATEGORY_* | ✔ | ✔ | view |
| PRODUCT_* | ✔ | ✔ | view + (create/update opt) |
| UNIT_MANAGE | ✔ | ✔ | — |
| INVENTORY_VIEW / ADJUST | ✔ | ✔ / ✔ | view / adjust |
| SALE_VIEW / CREATE | ✔ | ✔ | ✔ |
| SALE_REVERSE | ✔ | ✔ | — |
| CUSTOMER_* | ✔ | ✔ | view + create/update |
| LEDGER_VIEW | ✔ | ✔ | ✔ |
| PAYMENT_VIEW / CREATE | ✔ | ✔ | ✔ |
| PAYMENT_REVERSE | ✔ | ✔ | — |
| DELIVERY_* | ✔ | ✔ | ✔ |
| EXPENSE_* | ✔ | ✔ | — |
| REPORT_VIEW | ✔ | ✔ | limited |
| SETTINGS_* | ✔ | ✔ | — |
| USER_MANAGE | ✔ | ✔ (own staff) | — |
| PLATFORM_MANAGE / AUDIT_VIEW / IMPERSONATE_SHOP | ✔ | — | — |

Tenant scope is orthogonal to permissions: even with `SALE_VIEW`, a shop user only ever
sees their own shop's sales because the repository injects `shopId` from context.
