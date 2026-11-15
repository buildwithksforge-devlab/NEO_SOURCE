# Shared document layout repair

The supplied `folio-statement-INV-2026-000056.pdf` exposed overlapping header artwork/metadata, colliding numeric table columns and a balance band too close to preceding totals. Font embedding and financial-data corrections alone had not repaired that layout.

The A4 renderer now follows the existing preview: property trading name and bounded logo/initials at top left, legal identity below, the same clipped 62 × 42 mm wireframe viewport, a brown title block, and metadata below the artwork. Tables use printable-width profiles, measured cell wrapping, repeated headers and dotted row rules. The folio profile uses number/date/description/category/quantity/amount. Currency is stated in metadata rather than repeated in every cell. Totals have separate vertical space; the footer uses Phone/Mail/Address and the quiet NEØ signature. Dates use the record property's configured timezone, with the timezone stated explicitly.

Validation: actual renderer generated one-row and 38-row folio fixtures, plus all nine other supported A4 profiles with long descriptions, unbroken references and large amounts. Folio, continuation/final pages, GRN and salary-layout fixtures were rendered through Poppler and visually inspected. These are synthetic layout checks; no business operation, payroll release or payment was performed. The document/report contract suites passed 52 tests after a filesystem-scanning test was rerun sequentially following a host-load timeout.

The narrow thermal receipt keeps its separate roll layout. Full report styling, remaining logo-format handling, quotations and other app export paths remain in the product queue; this repair does not certify every financial figure or every document endpoint.
