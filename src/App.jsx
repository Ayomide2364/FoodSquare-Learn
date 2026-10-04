import { useCallback, useEffect, useMemo, useState } from "react";

const money = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0
});
const categories = [
    ["all", "Everything"], ["classic", "Classics"], ["loaded", "Loaded"],
    ["spicy", "A little spicy"], ["sharing", "For sharing"]
];
const orderStatuses = ["pending", "preparing", "shipped", "completed", "cancelled"];

function readSaved(key, fallback) {
    try {
        const result = JSON.parse(localStorage.getItem(key) || "null");
        return result ?? fallback;
    } catch (error) {
        console.error(`Could not read ${key} from browser storage.`, error);
        return fallback;
    }
}

function readCart() {
    const saved = readSaved("fryday-cart", []);
    return Array.isArray(saved)
        ? saved.filter((item) => Array.isArray(item) && typeof item[0] === "string"
            && Number.isInteger(item[1]) && item[1] > 0 && item[1] <= 20)
        : [];
}

function readFavorites() {
    const saved = readSaved("fryday-favorites", []);
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
}

function writeSaved(key, value, onError) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.error(`Could not save ${key} to browser storage.`, error);
        onError("Your browser could not save this preference on this device.");
    }
}

async function api(url, options = {}) {
    const response = await fetch(url, options);
    const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
        return result;
    }
    if (!response.ok) throw new Error(`The request failed (HTTP ${response.status}). Please try again.`);
    return response;
}

function Link({ to, navigate, className, children, ...props }) {
    return <a href={to} className={className} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to);
    }} {...props}>{children}</a>;
}

function App() {
    const [route, setRoute] = useState(window.location.pathname);
    const [products, setProducts] = useState([]);
    const [loadingMenu, setLoadingMenu] = useState(true);
    const [menuError, setMenuError] = useState("");
    const [cart, setCart] = useState(readCart);
    const [favorites, setFavorites] = useState(readFavorites);
    const [user, setUser] = useState(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [toast, setToast] = useState("");
    const [selectedProduct, setSelectedProduct] = useState(null);
    const [trackingPrefill, setTrackingPrefill] = useState(null);
    const [receipt, setReceipt] = useState(null);

    const navigate = useCallback((to) => {
        window.history.pushState({}, "", to);
        setRoute(window.location.pathname);
        setMenuOpen(false);
        setSelectedProduct(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
    }, []);

    useEffect(() => {
        const onPopState = () => {
            setRoute(window.location.pathname);
            setMenuOpen(false);
        };
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, []);

    useEffect(() => {
        writeSaved("fryday-cart", cart, setToast);
    }, [cart]);

    useEffect(() => {
        writeSaved("fryday-favorites", favorites, setToast);
    }, [favorites]);

    useEffect(() => {
        let active = true;
        api("/api/menu").then((data) => {
            if (active) {
                setProducts(data);
                setCart((current) => current.filter(([id]) => data.some((product) => product.id === id)));
                setFavorites((current) => current.filter((id) => data.some((product) => product.id === id)));
            }
        }).catch((error) => {
            if (active) setMenuError(error.message);
        }).finally(() => {
            if (active) setLoadingMenu(false);
        });
        api("/api/auth/me").then(({ user: currentUser }) => {
            if (active) setUser(currentUser);
        }).catch((error) => {
            if (active) console.error("Could not check the current account.", error);
        });
        const query = new URLSearchParams(window.location.search);
        if (query.has("resetToken")) {
            window.history.replaceState({}, "", `/account${window.location.search}`);
            setRoute("/account");
        }
        if (query.has("authError")) setToast("We couldn't complete sign-in. Please try again.");
        if (query.has("auth")) setToast("You're signed in. Welcome to Fryday!");
        if (query.get("emailVerification") === "success") setToast("Your email is verified. You're signed in!");
        if (query.get("emailVerification") === "invalid") setToast("That verification link is invalid or has expired.");
        return () => { active = false; };
    }, []);

    useEffect(() => {
        if (!toast) return undefined;
        const timer = window.setTimeout(() => setToast(""), 4800);
        return () => window.clearTimeout(timer);
    }, [toast]);

    const count = cart.reduce((total, [, quantity]) => total + quantity, 0);
    const addToCart = (product) => {
        setCart((current) => {
            const existing = current.find(([id]) => id === product.id);
            if (existing?.[1] >= 20) {
                setToast("You can add up to 20 of each menu item.");
                return current;
            }
            return existing
                ? current.map(([id, quantity]) => [id, id === product.id ? quantity + 1 : quantity])
                : [...current, [product.id, 1]];
        });
        setToast(`${product.name} added to your box.`);
    };
    const changeQuantity = (id, difference) => setCart((current) => current
        .map(([productId, quantity]) => [productId, productId === id ? quantity + difference : quantity])
        .filter(([, quantity]) => quantity > 0));
    const toggleFavorite = (id) => setFavorites((current) => current.includes(id)
        ? current.filter((favorite) => favorite !== id)
        : [...current, id]);
    const refreshMenu = async () => {
        const updated = await api("/api/menu");
        setProducts(updated);
    };

    return <div className="app-shell">
        <div className="announcement"><span>✳</span> A LITTLE JOY, FRESHLY FRIED · MADE FOR LASU <span>✳</span></div>
        <header className="site-header">
            <Link to="/" navigate={navigate} className="brand"><span className="brand-mark">f</span><span>fryday<span className="brand-dot">.</span></span></Link>
            <button className="mobile-menu-toggle" aria-label="Toggle navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>☰</button>
            <nav className={menuOpen ? "primary-nav is-open" : "primary-nav"}>
                <Link to="/" navigate={navigate}>Home</Link>
                <Link to="/menu" navigate={navigate}>The menu</Link>
                <Link to="/story" navigate={navigate}>Our story</Link>
                <Link to="/contact" navigate={navigate}>Find us</Link>
                <Link to="/track" navigate={navigate}>Track order</Link>
                <Link to={user?.role === "admin" ? "/admin" : "/account"} navigate={navigate}>{user ? "My account" : "Sign in"}</Link>
            </nav>
            <button className="header-cart" onClick={() => navigate("/cart")} aria-label={`Your box, ${count} items`}>
                <span className="cart-symbol">↗</span> Your box <span className="cart-count">{count}</span>
            </button>
        </header>

        {toast && <div role="status" className="toast"><span>{toast}</span><button onClick={() => setToast("")} aria-label="Dismiss">&times;</button></div>}

        <main key={route} className="page-transition">
            {route === "/" && <Home products={products} loading={loadingMenu} error={menuError} favorites={favorites} cart={cart} addToCart={addToCart} toggleFavorite={toggleFavorite} navigate={navigate} openProduct={setSelectedProduct} />}
            {route === "/menu" && <MenuPage products={products} loading={loadingMenu} error={menuError} favorites={favorites} cart={cart} addToCart={addToCart} toggleFavorite={toggleFavorite} openProduct={setSelectedProduct} />}
            {route === "/cart" && <CartPage products={products} cart={cart} setCart={setCart} changeQuantity={changeQuantity} navigate={navigate} onOrder={(order, phone) => {
                setReceipt({ order, phone });
                setTrackingPrefill({ orderId: String(order.id), phone });
                setCart([]);
            }} />}
            {route === "/track" && <TrackPage navigate={navigate} prefill={trackingPrefill} />}
            {route === "/account" && <AccountPage user={user} setUser={setUser} navigate={navigate} />}
            {route === "/admin" && <AdminPage user={user} products={products} refreshMenu={refreshMenu} setUser={setUser} navigate={navigate} />}
            {route === "/story" && <StoryPage navigate={navigate} />}
            {route === "/contact" && <ContactPage />}
            {!["/", "/menu", "/cart", "/track", "/account", "/admin", "/story", "/contact"].includes(route) && <NotFound navigate={navigate} />}
        </main>

        <Footer navigate={navigate} />

        {selectedProduct && <ProductDialog product={selectedProduct} inCart={cart.find(([id]) => id === selectedProduct.id)?.[1] || 0}
            onClose={() => setSelectedProduct(null)} onAdd={() => { addToCart(selectedProduct); setSelectedProduct(null); }} />}
        {receipt && <ReceiptDialog receipt={receipt} navigate={navigate} onClose={() => setReceipt(null)} />}
    </div>;
}

function Home({ products, loading, error, favorites, cart, addToCart, toggleFavorite, navigate, openProduct }) {
    return <>
        <section className="hero container">
            <div className="hero-copy">
                <p className="eyebrow"><span>01</span> THE CAMPUS FRIES CLUB</p>
                <h1>Fries for<br />your kind<br />of <em>day.</em></h1>
                <p className="hero-description">Long lecture? Short break? Whatever the day looks like, there's a golden, crispy moment with your name on it.</p>
                <div className="hero-actions"><button className="button button-dark" onClick={() => navigate("/menu")}>Find your favourite <span>↗</span></button><button className="button button-text" onClick={() => navigate("/story")}>A little about us <span>→</span></button></div>
                <div className="social-proof"><span className="stars">★★★★★</span><span>Your next between-classes ritual.</span></div>
                <div className="scroll-hint"><span>01 / 03</span><span>SCROLL FOR THE GOOD STUFF ↓</span></div>
            </div>
            <div className="hero-art">
                <div className="hero-image"><img src="https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=1100&q=88" alt="Crispy golden loaded fries" /></div>
                <div className="sun-badge">CRISP<br />HAPPY<br />REPEAT.</div><span className="hero-spark">✳</span>
                <span className="image-caption"><i /> THE FRYDAY CLASSIC</span>
            </div>
        </section>
        <div className="ticker"><div>HOT & GOLDEN <span>✳</span> MADE FOR THE BREAK <span>✳</span> GOOD MOOD FOOD <span>✳</span> HOT & GOLDEN <span>✳</span> MADE FOR THE BREAK <span>✳</span> GOOD MOOD FOOD <span>✳</span></div></div>
        <section className="section container home-menu">
            <div className="section-heading"><div><p className="eyebrow"><span>02</span> THE LINE-UP</p><h2>Pick your<br /><em>happy place.</em></h2></div><div className="heading-aside"><p>Keep it classic or go all in. Every box is a little break worth taking.</p><button className="button button-text" onClick={() => navigate("/menu")}>See the whole menu <span>↗</span></button></div></div>
            {error ? <p className="notice error">{error}</p> : <ProductGrid products={products.slice(0, 4)} loading={loading} favorites={favorites} cart={cart} addToCart={addToCart} toggleFavorite={toggleFavorite} openProduct={openProduct} />}
            <button className="button button-outline centered-button" onClick={() => navigate("/menu")}>Explore all the good stuff <span>↗</span></button>
        </section>
        <StoryTeaser navigate={navigate} />
        <section className="home-cta"><p>YOU'VE MADE IT THIS FAR.</p><h2>That's a sign.<br /><em>Get the fries.</em></h2><button className="button button-light" onClick={() => navigate("/menu")}>Explore the menu <span>↗</span></button><span className="cta-spark">✳</span></section>
    </>;
}

function ProductGrid({ products, loading, favorites, cart, addToCart, toggleFavorite, openProduct }) {
    if (loading) return <div className="product-grid">{[0, 1, 2, 3].map((item) => <div className="skeleton-card" key={item}><div /><span /></div>)}</div>;
    if (!products.length) return <p className="empty-state">No fries found. Try another search or filter.</p>;
    return <div className="product-grid">{products.map((product, index) => {
        const quantity = cart.find(([id]) => id === product.id)?.[1] || 0;
        const favorite = favorites.includes(product.id);
        return <article className="product-card" key={product.id} style={{ "--delay": `${index * 70}ms` }}>
            <button className="product-image" onClick={() => openProduct(product)} aria-label={`See ${product.name} details`}><img src={product.imageUrl} alt={product.name} loading="lazy" referrerPolicy="no-referrer" /><span className="product-tag">{product.tag}</span></button>
            <button className={favorite ? "favorite is-favorite" : "favorite"} onClick={() => toggleFavorite(product.id)} aria-label={favorite ? `Remove ${product.name} from saved favourites` : `Save ${product.name}`} aria-pressed={favorite}>{favorite ? "♥" : "♡"}</button>
            <div className="product-info"><button className="product-title" onClick={() => openProduct(product)}>{product.name}</button><strong>{money.format(product.price)}</strong></div>
            <p className="product-description">{product.description}</p>
            <div className="product-bottom"><span>{money.format(product.deliveryFee)} delivery / item</span><button className="add-button" onClick={() => addToCart(product)} disabled={quantity >= 20}>{quantity ? `Add another · ${quantity} in box` : "Add to my box"} <span>+</span></button></div>
        </article>;
    })}</div>;
}

function MenuPage({ products, loading, error, favorites, cart, addToCart, toggleFavorite, openProduct }) {
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState("all");
    const [sort, setSort] = useState("featured");
    const [savedOnly, setSavedOnly] = useState(false);
    const shown = useMemo(() => {
        const result = products.filter((product) => (category === "all" || product.category === category)
            && (!savedOnly || favorites.includes(product.id))
            && `${product.name} ${product.description}`.toLowerCase().includes(search.trim().toLowerCase()));
        if (sort === "price-asc") result.sort((a, b) => a.price - b.price);
        if (sort === "price-desc") result.sort((a, b) => b.price - a.price);
        if (sort === "name") result.sort((a, b) => a.name.localeCompare(b.name));
        return result;
    }, [products, category, favorites, savedOnly, search, sort]);
    return <section className="section container menu-page">
        <div className="page-intro"><p className="eyebrow"><span>THE GOOD STUFF</span> MADE FRESH FOR YOU</p><h1>Meet your<br /><em>new favourite.</em></h1><p>Find your perfect fry break. Every box is made to order and best enjoyed with a friend (or not—we get it).</p></div>
        <div className="menu-controls"><label className="search-control"><span>⌕</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search the menu..." /></label><label className="sort-control"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="featured">Featured</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option><option value="name">Name</option></select></label></div>
        <div className="filter-chips" aria-label="Menu filters">{categories.map(([id, label]) => <button key={id} className={category === id && !savedOnly ? "chip active" : "chip"} onClick={() => { setCategory(id); setSavedOnly(false); }}>{label}</button>)}<button className={savedOnly ? "chip active" : "chip"} onClick={() => { setSavedOnly(!savedOnly); setCategory("all"); }}>♡ Saved <span>{favorites.length}</span></button></div>
        {error ? <p className="notice error">{error}</p> : <ProductGrid products={shown} loading={loading} favorites={favorites} cart={cart} addToCart={addToCart} toggleFavorite={toggleFavorite} openProduct={openProduct} />}
    </section>;
}

function ProductDialog({ product, inCart, onClose, onAdd }) {
    useEffect(() => {
        const close = (event) => { if (event.key === "Escape") onClose(); };
        window.addEventListener("keydown", close);
        return () => window.removeEventListener("keydown", close);
    }, [onClose]);
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="product-modal" role="dialog" aria-modal="true" aria-label={`${product.name} details`}><button className="modal-close" onClick={onClose} aria-label="Close">&times;</button><img src={product.imageUrl} alt={product.name} /><div className="product-modal-copy"><p className="eyebrow">{product.tag}</p><h2>{product.name}</h2><p>{product.description}</p><h3>In the box</h3><ul>{product.contents.map((item) => <li key={item}>{item}</li>)}</ul><p className="subtle">{money.format(product.deliveryFee)} delivery per item</p><div className="modal-action"><strong>{money.format(product.price)}</strong><button className="button button-dark" disabled={inCart >= 20} onClick={onAdd}>Add to your box <span>↗</span></button></div></div></section></div>;
}

function CartPage({ products, cart, setCart, changeQuantity, navigate, onOrder }) {
    const [fulfillment, setFulfillment] = useState("delivery");
    const [promo, setPromo] = useState("");
    const [appliedPromo, setAppliedPromo] = useState("");
    const [promoMessage, setPromoMessage] = useState("");
    const [status, setStatus] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const items = cart.map(([id, quantity]) => ({ product: products.find((item) => item.id === id), id, quantity })).filter((item) => item.product);
    const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
    const delivery = fulfillment === "delivery" ? items.reduce((sum, item) => sum + item.product.deliveryFee * item.quantity, 0) : 0;
    const discount = appliedPromo ? Math.min(Math.floor(subtotal * 0.1), 1500) : 0;
    const submitOrder = async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const phone = String(data.get("phone") || "").trim();
        setSubmitting(true);
        setStatus("");
        try {
            const { order } = await api("/api/orders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    customerName: data.get("customerName"), phone, email: data.get("email"),
                    address: fulfillment === "delivery" ? data.get("address") : "",
                    fulfillment, paymentMethod: fulfillment === "delivery" ? "cash_on_delivery" : "cash_on_pickup",
                    promoCode: appliedPromo, notes: data.get("notes"),
                    items: cart.map(([productId, quantity]) => ({ productId, quantity }))
                })
            });
            onOrder(order, phone);
        } catch (error) {
            setStatus(error.message);
        } finally {
            setSubmitting(false);
        }
    };
    return <section className="section container cart-page">
        <p className="eyebrow"><span>READY WHEN YOU ARE</span> YOUR NEXT HAPPY MOMENT</p><h1>Your fry <em>box.</em></h1>
        {!items.length ? <div className="empty-cart"><div className="empty-icon">✳</div><h2>Your box is waiting.</h2><p>Pick a favourite from the menu and we'll take it from there.</p><button className="button button-dark" onClick={() => navigate("/menu")}>Meet the menu <span>↗</span></button></div> : <div className="checkout-layout">
            <section className="checkout-products"><h2>Your picks <span>{cart.reduce((sum, [, qty]) => sum + qty, 0)} items</span></h2>{items.map(({ product, id, quantity }) => <article className="checkout-item" key={id}><img src={product.imageUrl} alt="" /><div className="checkout-item-name"><strong>{product.name}</strong><small>{money.format(product.price)} each</small></div><div className="quantity-stepper"><button type="button" onClick={() => changeQuantity(id, -1)} aria-label={`Remove one ${product.name}`}>−</button><span>{quantity}</span><button type="button" disabled={quantity >= 20} onClick={() => changeQuantity(id, 1)} aria-label={`Add one ${product.name}`}>+</button></div><strong className="line-price">{money.format(quantity * product.price)}</strong></article>)}
                <button className="button button-text continue-shopping" onClick={() => navigate("/menu")}>← Keep looking</button>
                <div className="promo-box"><label htmlFor="promo">Have a little treat for yourself?</label><div><input id="promo" value={promo} onChange={(event) => { setPromo(event.target.value); setAppliedPromo(""); setPromoMessage(""); }} placeholder="Promo code" /><button type="button" onClick={() => { const code = promo.trim().toUpperCase(); if (!code) { setPromoMessage("Enter a promo code first."); return; } if (code !== "FRYDAY10") { setAppliedPromo(""); setPromoMessage("That code isn't valid. Try FRYDAY10."); return; } setAppliedPromo(code); setPromoMessage("FRYDAY10 applied — 10% off food, up to ₦1,500."); }}>Apply</button></div><p className={appliedPromo ? "success-copy" : ""}>{promoMessage}</p></div>
            </section>
            <form className="checkout-form" onSubmit={submitOrder}><h2>A few little details</h2>
                <label className="field">Your name<input name="customerName" autoComplete="name" minLength="2" maxLength="80" required /></label>
                <label className="field">Phone number<input name="phone" type="tel" autoComplete="tel" pattern="\+?[0-9][0-9\s()\-]{5,18}[0-9]" maxLength="20" placeholder="+234 801 234 5678" required /></label>
                <label className="field">Email <span>optional, for order updates</span><input name="email" type="email" maxLength="254" autoComplete="email" /></label>
                <fieldset className="choice-field"><legend>How would you like it?</legend><label className={fulfillment === "delivery" ? "choice selected" : "choice"}><input type="radio" name="fulfillment" checked={fulfillment === "delivery"} onChange={() => setFulfillment("delivery")} /> Bring it to me <small>Delivery fee per item</small></label><label className={fulfillment === "pickup" ? "choice selected" : "choice"}><input type="radio" name="fulfillment" checked={fulfillment === "pickup"} onChange={() => setFulfillment("pickup")} /> I'll pick it up <small>Free</small></label></fieldset>
                {fulfillment === "delivery" && <label className="field">Delivery address<textarea name="address" rows="2" maxLength="240" autoComplete="street-address" placeholder="Street, area and campus landmark" required /></label>}
                <p className="cash-note">♡ Cash only. Pay {fulfillment === "delivery" ? "when your order arrives" : "when you collect your order"}.</p>
                <label className="field">A note for us <span>optional</span><textarea name="notes" rows="2" maxLength="300" /></label>
                <div className="order-total"><span>Food subtotal</span><strong>{money.format(subtotal)}</strong><span>Delivery fees</span><strong>{delivery ? money.format(delivery) : "Free"}</strong>{discount > 0 && <><span>Promo savings</span><strong>−{money.format(discount)}</strong></>}<b>Due at handoff</b><b>{money.format(subtotal + delivery - discount)}</b></div>
                {status && <p className="notice error" role="alert">{status}</p>}<button className="button button-dark checkout-submit" disabled={submitting}>{submitting ? "Placing your order..." : "Place your order"} <span>↗</span></button>
            </form>
        </div>}
    </section>;
}

function TrackPage({ navigate, prefill }) {
    const [order, setOrder] = useState(null);
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);
    const [phone, setPhone] = useState(prefill?.phone || "");
    useEffect(() => {
        if (prefill) {
            setPhone(prefill.phone);
            setOrder(null);
        }
    }, [prefill]);
    const lookup = async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const orderId = String(data.get("orderId"));
        const selectedPhone = String(data.get("phone")).trim();
        setPhone(selectedPhone);
        setBusy(true);
        setStatus("Looking up your order...");
        setOrder(null);
        try {
            const result = await api(`/api/orders/${encodeURIComponent(orderId)}?phone=${encodeURIComponent(selectedPhone)}`);
            setOrder(result.order);
            setStatus("");
        } catch (error) {
            setStatus(error.message);
        } finally {
            setBusy(false);
        }
    };
    const cancelOrder = async () => {
        if (!order) return;
        setBusy(true);
        try {
            await api(`/api/orders/${order.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) });
            setOrder({ ...order, status: "cancelled" });
            setStatus("Your order has been cancelled.");
        } catch (error) {
            setStatus(error.message);
        } finally {
            setBusy(false);
        }
    };
    return <section className="section container track-page"><div className="page-intro"><p className="eyebrow"><span>MADE AN ORDER?</span> WE'VE GOT YOU</p><h1>Where are my<br /><em>fries at?</em></h1><p>Enter your order number and checkout phone number to check in on your order.</p></div><div className="track-card"><form onSubmit={lookup}><label className="field">Order number<input name="orderId" type="number" min="1" required defaultValue={prefill?.orderId || ""} placeholder="e.g. 1042" /></label><label className="field">Phone number<input name="phone" type="tel" required defaultValue={prefill?.phone || ""} placeholder="+234 801 234 5678" /></label><button className="button button-dark" disabled={busy}>{busy ? "Checking..." : "Check my order"} <span>↗</span></button></form>{status && <p className={order?.status === "cancelled" ? "notice success-copy" : "notice"} role="status">{status}</p>}
        {order && <article className="tracked-order"><div className="tracked-heading"><div><p className="eyebrow">ORDER #{order.id}</p><h2>It's <em>{order.status}.</em></h2></div><span className={`status-pill status-${order.status}`}>{order.status}</span></div><p>{order.fulfillment === "delivery" ? "Delivery · Cash on delivery" : "Pickup · Cash at handoff"} · {money.format(order.total)}</p><p className="subtle">{new Date(order.createdAt).toLocaleString()}</p><ul>{order.items.map((item) => <li key={item.name}>{item.quantity} × {item.name}</li>)}</ul>{order.status === "pending" && <button className="button button-outline" disabled={busy} onClick={cancelOrder}>Cancel this order</button>}</article>}
        </div><div className="soft-note"><span>✳</span><p><strong>Need a hand?</strong><br />Give us a call and we'll help you find your order.</p><a href="tel:+2348133450820">+234 813 345 0820</a></div><button className="button button-text" onClick={() => navigate("/menu")}>← Back to the menu</button></section>;
}

function AccountPage({ user, setUser, navigate }) {
    const [orders, setOrders] = useState([]);
    const [mode, setMode] = useState(new URLSearchParams(window.location.search).has("resetToken") ? "reset" : "login-choices");
    const [message, setMessage] = useState("");
    const [pendingEmail, setPendingEmail] = useState("");
    const [busy, setBusy] = useState(false);
    const [phoneIntent, setPhoneIntent] = useState("login");
    const [phoneDetails, setPhoneDetails] = useState({ name: "", phone: "" });
    const [canResendVerification, setCanResendVerification] = useState(false);
    const signupMode = ["signup-choices", "register", "verify"].includes(mode)
        || ["phone-send", "phone"].includes(mode) && phoneIntent === "register";
    const resetToken = new URLSearchParams(window.location.search).get("resetToken") || "";
    const loadOrders = useCallback(async () => {
        if (!user) return;
        try {
            const result = await api("/api/account/orders");
            setOrders(result.orders);
        } catch (error) {
            setMessage(error.message);
        }
    }, [user]);
    useEffect(() => { loadOrders(); }, [loadOrders]);
    useEffect(() => {
        if (!user || user.role !== "customer") return undefined;
        const timer = window.setInterval(loadOrders, 15000);
        return () => window.clearInterval(timer);
    }, [user, loadOrders]);
    const submitAuth = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form));
        setBusy(true);
        setMessage("");
        setCanResendVerification(false);
        try {
            if (mode === "login" || mode === "register") {
                const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
                const result = await api(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
                if (mode === "register") {
                    setPendingEmail(result.email);
                    setMessage(result.message);
                    setMode("verify");
                } else {
                    setUser(result.user);
                }
            } else if (mode === "reset-request") {
                const result = await api("/api/auth/password-reset/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
                setMessage(`${result.message} If you have a verified email-and-password account, check your inbox and spam or junk folder.`);
            } else if (mode === "reset") {
                const result = await api("/api/auth/password-reset/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: data.password, token: resetToken }) });
                window.history.replaceState({}, "", "/account");
                setMode("login");
                setMessage(result.message);
            } else if (mode === "phone") {
                const result = await api("/api/auth/phone/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, createAccount: data.intent === "register" }) });
                setUser(result.user);
            }
        } catch (error) {
            setMessage(error.message);
            setCanResendVerification(mode === "login" && error.message.toLowerCase().includes("verify your email"));
        } finally {
            setBusy(false);
        }
    };
    const sendPhoneCode = async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget));
        setBusy(true);
        setMessage("");
        try {
            const result = await api("/api/auth/phone/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: data.phone, name: data.name || "", createAccount: data.intent === "register" }) });
            setPhoneDetails({ name: data.name || "", phone: data.phone });
            setPhoneIntent(data.intent);
            setMessage(result.message);
            setMode("phone");
        } catch (error) {
            setMessage(error.message);
        } finally {
            setBusy(false);
        }
    };
    const logout = async () => {
        try {
            await api("/api/auth/logout", { method: "POST" });
            setUser(null);
            setOrders([]);
            setMessage("You've signed out. See you again soon.");
        } catch (error) {
            setMessage(error.message);
        }
    };
    const cancelAccountOrder = async (orderId) => {
        try {
            await api(`/api/account/orders/${orderId}/cancel`, { method: "POST" });
            await loadOrders();
        } catch (error) {
            setMessage(error.message);
        }
    };
    return <section className="section container account-page"><div className="page-intro"><p className="eyebrow"><span>YOUR FRYDAY</span> YOUR ACCOUNT</p><h1>{user ? <>Hello, <em>{user.name.split(" ")[0]}.</em></> : <>A little place<br /><em>of your own.</em></>}</h1><p>{user ? "Your past orders, all in one happy place." : "Sign in to keep your orders close and your favourite fry breaks closer."}</p></div>
        {user ? <div className="account-dashboard"><div className="account-welcome"><div className="avatar">{user.name.charAt(0).toUpperCase()}</div><div><strong>{user.name}</strong><span>{user.email || user.phone}</span></div><button className="button button-text" onClick={logout}>Sign out ↗</button></div><div className="account-section-heading"><div><p className="eyebrow">A LITTLE TRIP DOWN MEMORY LANE</p><h2>Your orders</h2></div><button className="button button-outline" onClick={loadOrders}>Refresh ↻</button></div>{message && <p className="notice">{message}</p>}{orders.length ? <div className="account-order-list">{orders.map((order) => <OrderCard key={order.id} order={order} onCancel={() => cancelAccountOrder(order.id)} />)}</div> : <div className="empty-cart"><div className="empty-icon">✳</div><h2>Your story starts here.</h2><p>Your order history will show up here once you've placed your first order.</p><button className="button button-dark" onClick={() => navigate("/menu")}>Choose your fries <span>↗</span></button></div>}</div>
            : <div className="auth-card"><div className="auth-tabs"><button className={!signupMode ? "active" : ""} onClick={() => { setMode("login-choices"); setMessage(""); setCanResendVerification(false); }}>Sign in</button><button className={signupMode ? "active" : ""} onClick={() => { setMode("signup-choices"); setMessage(""); setCanResendVerification(false); }}>Create account</button></div>
                {["login-choices", "signup-choices"].includes(mode) ? <div className="auth-form auth-options"><h2>{mode === "signup-choices" ? "Make yourself at home." : "Welcome back."}</h2><p className="auth-options-intro">{mode === "signup-choices" ? "Choose how you'd like to join the Fryday family." : "Choose how you'd like to sign in."}</p>
                    <button className="auth-option" type="button" onClick={() => { const intent = mode === "signup-choices" ? "register" : "login"; setPhoneIntent(intent); setMode(intent); setMessage(""); }}><span className="auth-option-icon">✉</span><span><strong>Continue with email</strong><small>Email address and password</small></span><span className="auth-option-arrow">›</span></button>
                    <a className="auth-option" href="/api/auth/google"><span className="auth-option-icon google-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5h6.7c3.9-3.6 6-8.8 6-14.9Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.7-5c-1.8 1.2-4.1 2-6.8 2-5.2 0-9.6-3.5-11.2-8.3H5.9v5.2A20 20 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.8 27.9a12 12 0 0 1 0-7.8v-5.2H5.9a20 20 0 0 0 0 18.2l6.9-5.2Z"/><path fill="#EA4335" d="M24 12.2c3 0 5.7 1 7.8 3.1l5.8-5.8A19.4 19.4 0 0 0 24 4 20 20 0 0 0 5.9 14.9l6.9 5.2c1.6-4.8 6-7.9 11.2-7.9Z"/></svg></span><span><strong>Continue with Google</strong><small>Use your Google account</small></span><span className="auth-option-arrow">›</span></a>
                    <button className="auth-option" type="button" onClick={() => { setPhoneIntent(mode === "signup-choices" ? "register" : "login"); setMode("phone-send"); setMessage(""); }}><span className="auth-option-icon phone-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="6.25" y="2.75" width="11.5" height="18.5" rx="2.2" /><path d="M10 5.7h4M10.5 18.1h3" /></svg></span><span><strong>Continue with phone</strong><small>Get a one-time text verification code</small></span><span className="auth-option-arrow">›</span></button>
                    <p className="auth-options-switch">{mode === "signup-choices" ? "Already have an account?" : "New to Fryday?"} <button type="button" onClick={() => { setMode(mode === "signup-choices" ? "login-choices" : "signup-choices"); setMessage(""); }}>{mode === "signup-choices" ? "Sign in" : "Create an account"}</button></p>
                </div>
                    : mode === "verify" ? <div className="auth-form"><div className="auth-icon">✉</div><h2>Check your inbox.</h2><p>{message} {pendingEmail}</p><button className="button button-outline full-button" disabled={busy} onClick={async () => { setBusy(true); try { const result = await api("/api/auth/email/verification/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: pendingEmail }) }); setMessage(result.message); } catch (error) { setMessage(error.message); } finally { setBusy(false); } }}>Send another verification link</button><button className="button button-text" onClick={() => setMode("login-choices")}>← Back to sign-in options</button></div>
                    : mode === "phone-send" ? <form className="auth-form" onSubmit={sendPhoneCode}><h2>{phoneIntent === "register" ? "Join us by phone." : "Sign in by phone."}</h2><p className="subtle">We'll text a one-time verification code to your phone. Use your international number, for example +2348012345678.</p>{phoneIntent === "register" && <label className="field">Your name<input name="name" autoComplete="name" minLength="2" maxLength="80" required /></label>}<label className="field">Phone number<input name="phone" type="tel" placeholder="+2348012345678" required /></label><input type="hidden" name="intent" value={phoneIntent} />{message && <p className="notice" role="status">{message}</p>}<button className="button button-dark full-button" type="submit" disabled={busy}>{busy ? "Sending..." : "Send a verification code"} <span>↗</span></button><button type="button" className="button button-text" onClick={() => { setMode(phoneIntent === "register" ? "signup-choices" : "login-choices"); setMessage(""); }}>← Back to sign-in options</button></form>
                    : <form className="auth-form" onSubmit={submitAuth}>
                        <h2>{mode === "register" ? "Come on in." : mode === "reset-request" ? "Forgot your password?" : mode === "reset" ? "A fresh start." : mode === "phone" ? "One little code." : "Welcome back."}</h2>
                        {mode === "register" && <label className="field">Your name<input name="name" autoComplete="name" minLength="2" maxLength="80" required /></label>}
                        {mode === "phone" ? <><input type="hidden" name="intent" value={phoneIntent} />{phoneIntent === "register" && <label className="field">Your name<input name="name" autoComplete="name" minLength="2" maxLength="80" defaultValue={phoneDetails.name} required /></label>}<label className="field">Phone number<input name="phone" type="tel" defaultValue={phoneDetails.phone} required /></label><label className="field">Verification code<input name="code" inputMode="numeric" required /></label><button className="button button-dark full-button" type="submit" disabled={busy}>Verify and {phoneIntent === "register" ? "create account" : "sign in"} <span>↗</span></button><button type="button" className="button button-text" onClick={() => setMode("phone-send")}>← Change phone number</button></>
                            : mode === "reset" ? <label className="field">New password<input name="password" type="password" minLength="12" maxLength="128" autoComplete="new-password" required /></label>
                                : <><label className="field">Email address<input name="email" type="email" maxLength="254" autoComplete="email" required /></label>{mode !== "reset-request" && <label className="field">Password<input name="password" type="password" minLength={mode === "register" ? "12" : undefined} maxLength="128" autoComplete={mode === "register" ? "new-password" : "current-password"} required /></label>}</>}
                        {mode === "register" && <p className="subtle">Use at least 12 characters for your password. We'll send you an email to verify your account.</p>}
                        {message && <p className="notice" role="status">{message}</p>}
                        {mode !== "phone" && <button className="button button-dark full-button" type="submit" disabled={busy}>{busy ? "One moment..." : mode === "register" ? "Create my account" : mode === "reset-request" ? "Send reset link" : mode === "reset" ? "Reset password" : "Sign in"} <span>↗</span></button>}
                        {canResendVerification && <button type="button" className="button button-outline full-button" disabled={busy} onClick={async (event) => { const email = event.currentTarget.form.elements.email.value; setBusy(true); try { const result = await api("/api/auth/email/verification/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }); setMessage(result.message); } catch (error) { setMessage(error.message); } finally { setBusy(false); } }}>Resend verification email</button>}
                        {mode === "login" && <div className="auth-secondary"><button type="button" onClick={() => { setMode("reset-request"); setMessage(""); }}>Forgot password?</button><button type="button" onClick={() => { setMode("login-choices"); setMessage(""); }}>‹ All sign-in options</button></div>}
                        {mode === "reset-request" && <button type="button" className="button button-text" onClick={() => { setMode("login-choices"); setMessage(""); }}>← Back to sign in</button>}
                        {mode === "reset-request" && <p className="reset-spam-reminder">Password reset is for verified email-and-password accounts. If you joined with Google or phone, use that sign-in option instead. No email yet? Check your spam or junk folder.</p>}
                        {mode === "reset" && message && <button type="button" className="button button-text" onClick={() => setMode("login-choices")}>Back to sign in</button>}
                    </form>}
            </div>}
        <button className="button button-text account-back" onClick={() => navigate("/")}>← Back home</button>
    </section>;
}

function OrderCard({ order, onCancel, admin = false, onStatusChange }) {
    return <article className="account-order-card"><div className="order-card-top"><strong>Order #{order.id}</strong><span className={`status-pill status-${order.status}`}>{order.status}</span></div><p>{order.fulfillment === "delivery" ? "Delivery" : "Pickup"} · {money.format(order.total)} · {new Date(order.createdAt).toLocaleString()}</p><p className="order-item-list">{order.items.map((item) => `${item.quantity} × ${item.name}`).join(" · ")}</p>{admin && <div className="admin-customer"><strong>{order.customerName}</strong> · {order.phone}{order.customerEmail && ` · ${order.customerEmail}`}{order.address && <p>{order.address}</p>}{order.notes && <p>Note: {order.notes}</p>}<div className="admin-status-control"><select aria-label={`Status for order ${order.id}`} defaultValue={order.status} onChange={(event) => onStatusChange(order.id, event.target.value)}>{orderStatuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></div></div>}{!admin && order.status === "pending" && <button className="button button-text cancel-order" onClick={onCancel}>Cancel order</button>}</article>;
}

function AdminPage({ user, products, refreshMenu, setUser, navigate }) {
    const [orders, setOrders] = useState([]);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const refresh = useCallback(async () => {
        try {
            const result = await api("/api/admin/orders");
            setOrders(result.orders);
            setMessage("");
        } catch (error) {
            setMessage(error.message);
        }
    }, []);
    useEffect(() => {
        if (!user) api("/api/auth/me").then(({ user: current }) => setUser(current)).catch((error) => setMessage(error.message));
        if (user?.role === "admin") refresh();
    }, [user, setUser, refresh]);
    const updateStatus = async (id, status) => {
        try {
            await api(`/api/admin/orders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
            setMessage(`Order #${id} updated.`);
            await refresh();
        } catch (error) {
            setMessage(error.message);
        }
    };
    const uploadProduct = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        setBusy(true);
        setMessage("Uploading menu item...");
        try {
            const result = await api("/api/admin/menu", { method: "POST", body: new FormData(form) });
            form.reset();
            await refreshMenu();
            setMessage(`${result.product.name} is now available on the menu.`);
        } catch (error) {
            setMessage(error.message);
        } finally {
            setBusy(false);
        }
    };
    const deleteProduct = async (product) => {
        if (!window.confirm(`Remove ${product.name} from the menu?`)) return;
        try {
            await api(`/api/admin/menu/${encodeURIComponent(product.id)}`, { method: "DELETE" });
            await refreshMenu();
            setMessage(`${product.name} was removed from the menu.`);
        } catch (error) {
            setMessage(error.message);
        }
    };
    const logout = async () => {
        try {
            await api("/api/auth/logout", { method: "POST" });
            setUser(null);
            navigate("/account");
        } catch (error) {
            setMessage(error.message);
        }
    };
    return <section className="section container admin-page"><div className="page-intro"><p className="eyebrow"><span>THE FRYDAY TEAM</span> YOUR LITTLE CONTROL ROOM</p><h1>The order<br /><em>desk.</em></h1><p>All the behind-the-scenes good stuff, right here.</p></div>
        {!user ? <div className="empty-cart"><h2>Just a quick check.</h2><p>Sign in with an admin account to open the order desk.</p><button className="button button-dark" onClick={() => navigate("/account")}>Go to sign in <span>↗</span></button></div> : user.role !== "admin" ? <div className="empty-cart"><h2>This corner is for the team.</h2><p>Your account doesn't have admin access.</p><button className="button button-dark" onClick={() => navigate("/account")}>Go to your account <span>↗</span></button></div> : <>
            <div className="admin-user"><span>Signed in as <strong>{user.name}</strong></span><button className="button button-text" onClick={logout}>Sign out ↗</button></div>
            {message && <p className="notice" role="status">{message}</p>}
            <section className="admin-section"><div className="account-section-heading"><div><p className="eyebrow">HOT OFF THE PRESS</p><h2>All orders</h2></div><button className="button button-outline" onClick={refresh}>Refresh ↻</button></div>{orders.length ? <div className="account-order-list">{orders.map((order) => <OrderCard key={order.id} order={order} admin onStatusChange={updateStatus} />)}</div> : <div className="empty-panel">No orders just yet. The first one is on its way.</div>}</section>
            <section className="admin-section"><div className="account-section-heading"><div><p className="eyebrow">THE LINE-UP</p><h2>Menu management</h2></div></div><form className="admin-product-form" onSubmit={uploadProduct}><label className="field">Food name<input name="name" minLength="2" maxLength="80" required /></label><label className="field">Price (NGN)<input name="price" type="number" min="1" max="50000000" step="1" required /></label><label className="field">Delivery fee (NGN)<input name="deliveryFee" type="number" min="0" max="5000000" step="1" required /></label><label className="field">Category<select name="category" required><option value="classic">Classics</option><option value="loaded">Loaded</option><option value="spicy">A little spicy</option><option value="sharing">For sharing</option></select></label><label className="field">Card tag<input name="tag" maxLength="40" placeholder="NEW FAVOURITE" /></label><label className="field">Description<textarea name="description" maxLength="500" minLength="5" required /></label><label className="field">What's in the box? <span>comma-separated</span><input name="contents" maxLength="800" required /></label><label className="field field-full">Food photo <span>JPG, PNG or WebP · max 5 MB</span><input name="image" type="file" accept="image/jpeg,image/png,image/webp" required /></label><button className="button button-dark" disabled={busy}>{busy ? "Uploading..." : "Upload menu item"} <span>↗</span></button></form><div className="admin-products">{products.map((product) => <div key={product.id}><span>{product.name} <small>{money.format(product.price)}</small></span><button className="button button-text" onClick={() => deleteProduct(product)}>Remove</button></div>)}</div></section>
        </>}
    </section>;
}

function StoryTeaser({ navigate }) {
    return <section className="story-teaser"><div className="story-photo"><img src="https://images.unsplash.com/photo-1630384060421-cb20d0e0649d?auto=format&fit=crop&w=1000&q=85" alt="Freshly made golden fries" /><span>A LITTLE JOY<br />IN EVERY BOX.</span></div><div className="story-copy"><p className="eyebrow"><span>03</span> MADE FOR YOUR EVERYDAY</p><h2>Campus days<br />call for <em>crispy.</em></h2><p>Fryday is all about the simple things done with a little extra love: hot fries, feel-good flavours, and a reason to pause between the rush of classes.</p><p>We're here for the quick lunch, the post-lecture catch-up, and the "just one more bite" kind of afternoon.</p><button className="button button-dark" onClick={() => navigate("/story")}>A little more about us <span>↗</span></button></div></section>;
}

function StoryPage({ navigate }) {
    return <><section className="story-page container"><div className="page-intro"><p className="eyebrow"><span>OUR LITTLE CORNER</span> GOOD FRIES. GOOD DAYS.</p><h1>A campus day,<br /><em>made crispier.</em></h1><p>We're Fryday: your friendly neighbourhood fry break, made for the in-between moments.</p></div><div className="story-page-grid"><img src="https://images.unsplash.com/photo-1630384060421-cb20d0e0649d?auto=format&fit=crop&w=1100&q=85" alt="Fresh golden fries" /><div><p className="eyebrow">A LITTLE JOY IN EVERY BOX</p><h2>Made with love.<br />Made for <em>your day.</em></h2><p>Long lecture? Short break? A catch-up with your favourite people? We believe the small moments deserve something special.</p><p>That's why we make our fries fresh, bring a little extra care to every box, and keep the good stuff close to the LASU community.</p><button className="button button-dark" onClick={() => navigate("/menu")}>Meet your next favourite <span>↗</span></button></div></div></section><StoryTeaser navigate={navigate} /></>;
}

function ContactPage() {
    const mapQuery = "Lagos State University, Ojo, Lagos, Nigeria";
    const encodedMapQuery = encodeURIComponent(mapQuery);
    return <section className="contact-page">
        <div className="container contact-content">
            <p className="eyebrow"><span>YOUR NEXT FRY BREAK</span> COME SAY HELLO</p>
            <h1>See you around<br /><em>LASU.</em></h1>
            <p className="contact-intro">We're serving the LASU community. Give us a shout, or stop by the neighbourhood when you're ready for a little fry break.</p>
            <div className="contact-layout">
                <div className="contact-details">
                    <article className="contact-card">
                        <span className="contact-label">FIND OUR CORNER</span>
                        <strong>Lagos State University</strong>
                        <span>Ojo, Lagos, Nigeria</span>
                        <a className="contact-link" href={`https://www.google.com/maps/dir/?api=1&destination=${encodedMapQuery}`} target="_blank" rel="noreferrer">Get directions <span>↗</span></a>
                    </article>
                    <article className="contact-card">
                        <span className="contact-label">CALL THE FRYDAY LINE</span>
                        <a className="contact-main-link" href="tel:08133450820">08133450820</a>
                    </article>
                    <article className="contact-card">
                        <span className="contact-label">SEND US A WHATSAPP</span>
                        <a className="contact-main-link" href="https://wa.me/2348133450820" target="_blank" rel="noreferrer">+234 813 345 0820 <span>↗</span></a>
                    </article>
                    <article className="contact-card">
                        <span className="contact-label">DROP US A NOTE</span>
                        <a className="contact-main-link" href="mailto:frydayyy277@gmail.com">frydayyy277@gmail.com <span>↗</span></a>
                    </article>
                    <div className="social-links">
                        <span className="contact-label">A LITTLE MORE FRYDAY</span>
                        <a href="https://www.instagram.com/fryday.lasu/" target="_blank" rel="noreferrer">Instagram <span>@fryday.lasu</span> ↗</a>
                        <a href="https://www.tiktok.com/@fryday.lasu" target="_blank" rel="noreferrer">TikTok <span>@fryday.lasu</span> ↗</a>
                        <p>Social profiles are coming soon.</p>
                    </div>
                </div>
                <div className="map-card">
                    <iframe
                        title="Map showing Lagos State University in Ojo, Lagos"
                        src={`https://www.google.com/maps?q=${encodedMapQuery}&output=embed`}
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                        allowFullScreen
                    />
                    <div className="map-caption"><span className="map-pin">⌖</span><span><strong>Lagos State University</strong><small>Ojo, Lagos, Nigeria</small></span><a href={`https://www.google.com/maps/search/?api=1&query=${encodedMapQuery}`} target="_blank" rel="noreferrer" aria-label="Open Lagos State University in Google Maps">↗</a></div>
                </div>
            </div>
            <div className="contact-signoff"><span>✳</span> GOOD FRIES. GOOD DAYS. MADE FOR LASU.</div>
        </div>
    </section>;
}

function ReceiptDialog({ receipt, navigate, onClose }) {
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);
    const { order, phone } = receipt;
    const download = async () => {
        setBusy(true);
        setStatus("Preparing your receipt...");
        try {
            const response = await api(`/api/orders/${order.id}/receipt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) });
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement("a");
            link.href = url;
            link.download = `Fryday-Receipt-${order.id}.pdf`;
            link.click();
            URL.revokeObjectURL(url);
            setStatus("Receipt downloaded.");
        } catch (error) {
            setStatus(error.message);
        } finally {
            setBusy(false);
        }
    };
    return <div className="modal-backdrop receipt-backdrop"><section className="receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title"><div className="receipt-check">✓</div><p className="eyebrow">YOUR ORDER IS IN</p><h2 id="receipt-title">Well, this is <em>exciting.</em></h2><p>Thanks for your order! Your fries are being made with love.</p><div className="receipt-order-number"><span>ORDER NUMBER</span><strong>#{order.id}</strong></div><div className="receipt-item-list">{order.items.map((item) => <div key={item.id}><span>{item.quantity} × {item.name}</span><strong>{money.format(item.lineTotal)}</strong></div>)}</div><div className="receipt-lines"><span>Food subtotal</span><strong>{money.format(order.subtotal)}</strong><span>Delivery fees</span><strong>{order.deliveryFee ? money.format(order.deliveryFee) : "Free"}</strong>{order.discount > 0 && <><span>Promo savings</span><strong>−{money.format(order.discount)}</strong></>}<span>{order.fulfillment === "delivery" ? "Cash on delivery" : "Cash at pickup"}</span><strong>{money.format(order.total)}</strong><small>Due when your order is handed over</small></div><div className="receipt-actions"><button className="button button-dark" onClick={download} disabled={busy}>{busy ? "Preparing..." : "Download receipt PDF"} <span>↓</span></button><button className="button button-outline" onClick={() => window.print()}>Print receipt</button></div>{status && <p className="notice" role="status">{status}</p>}<button className="button button-text" onClick={() => { onClose(); navigate("/track"); }}>Track my order ↗</button><button className="modal-close" onClick={onClose} aria-label="Close">&times;</button></section></div>;
}

function Footer({ navigate }) {
    return <footer className="site-footer"><div className="footer-top"><Link to="/" navigate={navigate} className="brand"><span className="brand-mark">f</span><span>fryday<span className="brand-dot">.</span></span></Link><p>GOOD FRIES. GOOD DAYS.<br />MADE FOR LASU.</p><div><Link to="/menu" navigate={navigate}>The menu</Link><Link to="/track" navigate={navigate}>Track an order</Link><Link to="/account" navigate={navigate}>Your account</Link></div><a href="tel:+2348133450820">Say hello ↗</a></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Fryday. Made with a little extra love.</span><span>MADE FOR LAGOS STATE UNIVERSITY</span></div></footer>;
}

function NotFound({ navigate }) {
    return <section className="section container empty-cart"><div className="empty-icon">✳</div><p className="eyebrow">A LITTLE DETOUR</p><h1>Nothing tasty<br />on this page.</h1><p>Let's get you back to the good stuff.</p><button className="button button-dark" onClick={() => navigate("/")}>Back home <span>↗</span></button></section>;
}

export default App;
