# Version 3 multi-item box QR labels

A physical box can contain between one and five distinct Tally Stock Items. The box and each box-item relationship are stored in SQLite.

```json
{
  "type": "inventory-scanner/box",
  "version": 3,
  "companyId": "TALLY-COMPANY-GUID",
  "boxId": "BOX-00184",
  "revision": 4,
  "items": [
    {
      "tallyItemGuid": "TALLY-ITEM-GUID",
      "itemName": "Component A"
    }
  ]
}
```

The QR never stores supplier, Purchase Order, GRN, challan, rate, FIFO allocation, godown, or batch information. Those values are dynamic and come from the Local Stores Database.

When online, the phone treats the desktop server's current box record as authoritative. The embedded item list is an offline/compatibility fallback. Older one-item and version-2 labels remain readable.

The QR Creator only permits synchronized Tally Stock Items. Saving an existing box increments its revision, allowing the scanner to warn when a printed label is older than the current database record.
