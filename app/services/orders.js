/**
 * Order lifecycle for a skin marketplace.
 *
 * Delivery happens through a Steam trade offer, not a courier, so the status
 * vocabulary tracks escrow and trade confirmation rather than shipping.
 */
const ORDER_STATUS = {
    PENDING_PAYMENT: 'pending_payment',
    IN_ESCROW: 'in_escrow',
    TRADE_SENT: 'trade_sent',
    COMPLETED: 'completed',
    DISPUTED: 'disputed',
    REFUNDED: 'refunded',
    CANCELLED: 'cancelled',
};

const ORDER_STATUSES = Object.values(ORDER_STATUS);

const TRADE_OFFER_STATUS = {
    PENDING: 'pending',
    ACCEPTED: 'accepted',
    DECLINED: 'declined',
    CANCELLED: 'cancelled',
};

const TRADE_OFFER_STATUSES = Object.values(TRADE_OFFER_STATUS);

const TRADE_OFFER_DIRECTION = {
    INCOMING: 'incoming',
    OUTGOING: 'outgoing',
};

const WALLET_TRANSACTION = {
    TOPUP: 'topup',
    PURCHASE: 'purchase',
    REFUND: 'refund',
};

const WALLET_TRANSACTIONS = Object.values(WALLET_TRANSACTION);

// Statuses that mean the order is finished and should stop moving.
const TERMINAL_STATUSES = [ORDER_STATUS.COMPLETED, ORDER_STATUS.REFUNDED, ORDER_STATUS.CANCELLED];

function isValidOrderStatus(status) {
    return ORDER_STATUSES.includes(status);
}

function isTerminal(status) {
    return TERMINAL_STATUSES.includes(status);
}

/**
 * Allowed order-status moves. Kept explicit so a client can never walk an
 * order backwards out of a terminal state.
 */
const ALLOWED_TRANSITIONS = {
    [ORDER_STATUS.PENDING_PAYMENT]: [ORDER_STATUS.IN_ESCROW, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED],
    [ORDER_STATUS.IN_ESCROW]: [ORDER_STATUS.TRADE_SENT, ORDER_STATUS.DISPUTED, ORDER_STATUS.REFUNDED, ORDER_STATUS.CANCELLED],
    [ORDER_STATUS.TRADE_SENT]: [ORDER_STATUS.COMPLETED, ORDER_STATUS.DISPUTED, ORDER_STATUS.REFUNDED],
    [ORDER_STATUS.DISPUTED]: [ORDER_STATUS.COMPLETED, ORDER_STATUS.REFUNDED],
    [ORDER_STATUS.COMPLETED]: [],
    [ORDER_STATUS.REFUNDED]: [],
    [ORDER_STATUS.CANCELLED]: [],
};

function canTransition(from, to) {
    return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

module.exports = {
    ORDER_STATUS,
    ORDER_STATUSES,
    TRADE_OFFER_STATUS,
    TRADE_OFFER_STATUSES,
    TRADE_OFFER_DIRECTION,
    WALLET_TRANSACTION,
    WALLET_TRANSACTIONS,
    TERMINAL_STATUSES,
    isValidOrderStatus,
    isTerminal,
    canTransition,
};