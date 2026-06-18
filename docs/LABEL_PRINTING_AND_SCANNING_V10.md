# Label printing and deliberate scanning (v10)

## Printed label dimensions

The QR Code Creator prints four labels per page in a two-column by two-row layout. Each label is 3.75 inches wide and no more than 4 inches tall. The QR itself is exactly 2 inches by 2 inches.

The box ID and revision are printed above the QR. The synchronized Tally Stock Item names are printed as a numbered list below it. Text is intentionally kept outside the QR quiet zone; drawing text over the QR modules can reduce scan reliability, especially after photocopying or when labels are dirty.

The layout fits both A4 and US Letter paper with 0.25-inch print margins. Browser or operating-system print scaling should be set to 100% / Actual Size for an exact 2-inch QR.

## Scanner behavior

The camera view can remain open, but barcode detection is disabled by default. The operator must tap **Scan QR code** to arm the scanner. Only the next detected QR is accepted, after which scanning automatically pauses again. The operator can tap **Cancel scan** before a QR is detected.
