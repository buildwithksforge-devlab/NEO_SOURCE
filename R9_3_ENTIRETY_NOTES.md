# NEØ R9.3 Entirety convergence

- Continues R9.2 without discarding earlier commerce/public-app work.
- Corrects misleading Admin Hotel Information and Regional Settings “Save Changes” controls: those pages already persist through the tenant workspace debounce, so the old buttons only displayed success toasts and did not perform the save. UI now states that changes save automatically; existing failure toast remains authoritative.
- Adds regression contract preventing fake manual-save success from returning.
- Retains separate Cart/Checkout, Favourites, Guest folio checkout, provider-confirmed payment semantics, Rider/Partner convergence, contrast fixes, Zuri public discovery, and GRN property-scope guard.
