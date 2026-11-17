// Example menu loaded on first start. Prices in AED (stored in fils). Replace with the restaurant's real menu.
export const CATEGORIES = [
  { id: 'juice', en: 'Juices & shakes', ar: 'عصائر' },
  { id: 'wrap', en: 'Wraps', ar: 'سندويشات' },
  { id: 'main', en: 'Mains', ar: 'أطباق رئيسية' },
  { id: 'side', en: 'Sides & dessert', ar: 'مقبلات وحلويات' },
];

export const MENU = [
  { id: 'mango', cat: 'juice', en: 'Fresh Mango Juice', ar: 'عصير مانجو طازج', price: 14, desc: 'Alphonso mango, no added sugar', tags: ['Veg'], veg: 1, image: 'img/mango.jpg', kw: ['mango', 'مانجو'],
    addons: [['lg', 'Large size', 4], ['cream', 'Add a scoop of ice cream', 5], ['noice', 'No ice', 0]] },
  { id: 'avo', cat: 'juice', en: 'Avocado Shake', ar: 'شيك أفوكادو', price: 18, desc: 'Honey, mixed nuts', tags: ['Nuts', 'Dairy'], veg: 1, image: 'img/avo.jpg', kw: ['avocado', 'أفوكادو'],
    addons: [['lg', 'Large size', 4], ['honey', 'Extra honey', 2], ['nonuts', 'No nuts', 0]] },
  { id: 'shawarma', cat: 'wrap', en: 'Chicken Shawarma', ar: 'شاورما دجاج', price: 12, desc: 'Garlic sauce, pickles, fries inside', tags: ['Garlic'], veg: 0, best: 1, image: 'img/shawarma.jpg', kw: ['shawarma', 'shawerma', 'شاورما'],
    addons: [['meal', 'Make it a meal (fries + drink)', 8], ['cheese', 'Add cheese', 3], ['garlic', 'Extra garlic sauce', 1], ['nopickle', 'No pickles', 0]] },
  { id: 'falafel', cat: 'wrap', en: 'Falafel Wrap', ar: 'راب فلافل', price: 10, desc: 'Tahini, tomato, parsley', tags: ['Vegan', 'Sesame'], veg: 1, image: 'img/falafel.jpg', kw: ['falafel', 'فلافل'],
    addons: [['meal', 'Make it a meal (fries + drink)', 8], ['cheese', 'Add cheese', 3], ['spicy', 'Make it spicy', 0]] },
  { id: 'grill', cat: 'main', en: 'Mixed Grill Platter', ar: 'مشاوي مشكلة', price: 55, desc: 'Shish tawook, kofta, lamb tikka, rice. Serves 2', tags: ['Serves 2'], veg: 0, image: 'img/grill.jpg', kw: ['grill', 'platter', 'مشاوي'],
    addons: [['bread', 'Extra bread', 2], ['hummus', 'Add hummus', 8], ['garlic', 'Extra garlic sauce', 1]] },
  { id: 'biryani', cat: 'main', en: 'Chicken Biryani', ar: 'برياني دجاج', price: 32, desc: 'Basmati, raita, salan', tags: ['Spicy'], veg: 0, best: 1, image: 'img/biryani.jpg', kw: ['biryani', 'برياني'],
    addons: [['raita', 'Extra raita', 3], ['egg', 'Boiled egg', 2], ['spicy', 'Extra spicy', 0]] },
  { id: 'hummus', cat: 'side', en: 'Hummus & Bread', ar: 'حمص مع خبز', price: 15, desc: 'Olive oil, paprika, warm khubz', tags: ['Vegan', 'Sesame'], veg: 1, image: 'img/hummus.jpg', kw: ['hummus', 'hommos', 'حمص'],
    addons: [['meat', 'Top with spiced minced meat', 6], ['bread', 'Extra bread', 2]] },
  { id: 'kunafa', cat: 'side', en: 'Kunafa', ar: 'كنافة', price: 20, desc: 'Cheese kunafa, pistachio', tags: ['Nuts', 'Dairy'], veg: 1, image: 'img/kunafa.jpg', kw: ['kunafa', 'knafeh', 'kunafeh', 'كنافة'],
    addons: [['cream', 'Add a scoop of ice cream', 5], ['pist', 'Extra pistachio', 3]] },
];
