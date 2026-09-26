/**
 * The owner-supplied master inventory list, kept as a reference only.
 *
 * Nothing here writes to the catalogue. It exists so the master inventory view
 * can say honestly which supplied items are present in the catalogue and which
 * are still missing, without guessing at anything the owner did not supply.
 */

export type MasterGroup = { group: string; items: string[] };

export const MASTER_INVENTORY: MasterGroup[] = [
  { group: "Sea Food Products", items: ["Whole Tilapia", "Whole Taffi", "Red snapper fillet", "White snapper fillet"] },
  { group: "Poultry products", items: ["Eggs", "Capon", "Kienyeji", "Chicken sausage", "Chicken breast", "Chicken wings"] },
  { group: "Red meat products", items: ["T-bone", "Whole goat", "Beef sausage", "Lamb ribs", "Lamb chops", "Beef steak"] },
  { group: "Dairy product", items: ["Milk", "Whipping cream", "Cooking cream", "Cheese", "Ice cream", "Yoghurt"] },
  { group: "Fruits & Vegs", items: ["Water melon", "Mangoes", "Pineapple", "Cucumber", "Tomatoes", "Onion"] },
  { group: "Spices", items: ["Cardamon powder", "Red chill powder", "Kitchen king masala", "Curry powder"] },
  {
    group: "Dry goods",
    items: ["Rice", "Sugar", "Beans", "Salt", "Maize flour", "Wheat flour", "Dark Soy sauce", "Light Soy sauce", "Tomato ketchup"],
  },
  {
    group: "Tea & coffee",
    items: [
      "Dormans coffee beans 500gms",
      "Java coffee beans 500gms",
      "Java coffee fine grind 500gms",
      "Tea bags",
      "Tea leaves 500gms",
      "Herbal tea bags",
      "Drinking chocolate",
    ],
  },
  {
    group: "Beverages",
    items: [
      "Still water 500ml",
      "Still water 1000ml",
      "Sparkling water 1000ml",
      "Delmonte juice",
      "Pick n peal juice",
      "Coke",
      "Sprite",
      "Fanta orange",
      "Fanta pineapple",
      "Stoney",
    ],
  },
  { group: "Energy drink", items: ["Red bull"] },
  { group: "Liqueurs", items: ["Martin rosso", "Martin bianco", "Amarula", "Jagermeister"] },
  { group: "Vodka", items: ["Smirnoff vodka", "Absolut vodka", "Stoli"] },
  { group: "Gin", items: ["Beefeater", "Hendriks", "Tanqueray"] },
  { group: "Brandy", items: ["Hennessy VS", "Martel VSOP", "Martel VS"] },
  { group: "Tequila", items: ["Don Julio", "Camino silver", "Jose Cuervo"] },
  { group: "Rum", items: ["Malibu", "Bacardi", "Captain Morgan"] },
  { group: "Whiskey", items: ["Monkey Shoulder", "Johnnie Walker Black Label", "Jameson", "Jack Daniel"] },
  { group: "Single malt", items: ["Singleton 12yrs", "Glenfiddich 15yrs"] },
  { group: "Red wine", items: ["Robertson sweet red", "Jacobs Creek classic", "Nederburg cab sauv"] },
  { group: "White wine", items: ["Versus dry", "Jacobs Creek classic chardonnay"] },
  { group: "Sparkling & Champagne", items: ["Moet & Chandon Imperial Brut", "Swartland Winery Cuvee Brut"] },
  { group: "Beers", items: ["Tusker lager", "Tusker lite", "Balozi", "Heineken"] },
  { group: "General supplies", items: ["Take away containers", "Garbage bags"] },
  { group: "Guest supplies", items: ["Toilet paper", "Serviettes", "Toothpick", "Shower gel", "Shampoo", "Handwash"] },
  { group: "Cleaning detergents", items: ["Multi purpose soap"] },
  // Laundry detergents and Uniforms arrived empty on the supplied sheet. The
  // owner asked on 9 Sep 2026 for stock items to be added to them, so these
  // names were added then — they are not part of the original supplied list.
  {
    group: "Laundry detergents",
    items: ["Laundry powder", "Fabric softener", "Laundry bleach", "Stain remover"],
  },
  {
    group: "Cutleries & crockeries",
    items: [
      "Tea spoon",
      "Dessert spoon",
      "Meat fork",
      "Steak knife",
      "Table knife",
      "Dinner plates",
      "Side plates",
      "Tea cups",
      "Saucers",
      "Soup cups",
    ],
  },
  { group: "Kitchen ware", items: ["Cooking pots", "Serving spoons", "Chaffing dish", "Soup tureen"] },
  { group: "General Maintenance supplies", items: ["Sockets", "Switch", "Nails", "Cables"] },
  {
    group: "Stationeries",
    items: [
      "Conference writing pads",
      "Writing pen",
      "Printing paper",
      "A4 envelop",
      "A5 envelop",
      "C5 envelop",
      "Masking tape",
    ],
  },
  { group: "Computer accessories", items: ["Laptop HP", "Desktop"] },
  {
    group: "Uniforms",
    items: ["Chef jacket", "Chef trousers", "Waiter shirt", "Housekeeping dress", "Kitchen apron"],
  },
  { group: "Gas & Fuel", items: ["LPG gas", "Diesel", "Petrol", "Charcoal", "Fuel gel"] },
  { group: "Equipment & Appliances", items: ["Lawn mower", "Trimmer"] },
];

/**
 * Catalogue names carry a property suffix such as "Rice (SCM)". Comparison
 * ignores that suffix, case and spacing so the same item is not reported
 * missing once per property.
 */
export function masterKey(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export const MASTER_ITEM_KEYS = new Set(
  MASTER_INVENTORY.flatMap((g) => g.items.map((i) => masterKey(i))),
);

export const MASTER_ITEM_COUNT = MASTER_INVENTORY.reduce((n, g) => n + g.items.length, 0);
