const express = require('express');
const router = express.Router();
const yup = require("yup");
const { createToken } = require('../app/services/token');
const userRepo = require('../app/db/repos/user');
const validate = require('./middlewares/validate');
const phoneVerification = require('../app/services/phoneVerification');
const { normalizePhone, isValidPhone } = require('../app/services/phone');

/**
 * Shared phone rules. The value is normalized first, so "+98…", "0098…",
 * "912…" and Persian digits all validate as the one number they represent —
 * and anything that does not normalize to a real number is rejected.
 */
const phoneField = () => yup.string()
    .required()
    .test('phone-valid', 'Phone number is not valid', (value) => isValidPhone(value));

const loginSchema = yup.object({
    body : yup.object({
        phone : phoneField()
            .test('check-phone-exists' , 'the phone not exists' , async (value) => {
                let user = await userRepo.findBy('phone' , normalizePhone(value))
                return user !== undefined;
            })
    })
})

/* POST /login — issues a login challenge. The code goes to the backend terminal. */
router.post('/login', validate(loginSchema)  , async (req, res, next) => {
    try {
        const { phone } = req.body;
        const normalizedPhone = normalizePhone(phone);

        const user = await userRepo.findBy('phone' , normalizedPhone);

        const challenge = await phoneVerification.issueCode({
            phone: normalizedPhone,
            purpose: 'login',
        });

        return res.status(200).json({
            'status' : 'success',
            // The challenge id. Never the code — that would defeat the check.
            'token' : challenge.id,
        });

    } catch (err) {
        next(err);
    }
});


const loginStepTwoSchema = yup.object({
    body : yup.object({
        token : yup.string().required(),
        code : yup.string().required().matches(/^\d{6}$/, 'the code is not correct'),
    })
})

/* POST /login/verify-phone — consumes the login challenge. */
router.post('/login/verify-phone', validate(loginStepTwoSchema)  , async (req, res, next) => {
    try {
        const { token, code } = req.body;

        // One generic failure for an unknown id, a wrong code, an expired
        // challenge and one that ran out of attempts — otherwise this endpoint
        // tells an attacker which of those it hit.
        const result = await phoneVerification.consumeCode({ id: token, code });
        if (!result.ok) {
            return res.status(401).json({ 'status' : 'fail', 'message' : 'the code is not correct' });
        }

        const user = await userRepo.findBy('phone' , result.row.phone);
        if (!user) {
            return res.status(401).json({ 'status' : 'fail', 'message' : 'the code is not correct' });
        }

        // * CREATE JWT TOKEN
        const tokenJWT = createToken({ user_id: user.id, name: user.name, phone : user.phone })
        user.token = tokenJWT;
        await userRepo.update(user.id , { token : tokenJWT });

        return res.status(200).json({
            'status' : 'success',
            user
        });

    } catch (err) {
        next(err);
    }
});


const registerSchema = yup.object({
    body : yup.object({
        name : yup.string().required().min(2),
        phone : phoneField()
                .test('check-phone-exists' , 'the phone is already exists' , async (value) => {
                    let user = await userRepo.findBy('phone' , normalizePhone(value))
                    return user === undefined;
                })

    })
})

router.post('/register', validate(registerSchema) , async (req, res, next) => {

    try {
        const { name, phone } = req.body;


        let data = {
            name,
            // Canonical form only — a stored "+98…" would not match a later "09…" login.
            phone: normalizePhone(phone),
            created_at: Date.now()
        }

        await userRepo.create(data);

        return res.status(201).json({ status : 'success' });  
        
    } catch (err) {
      next(err);
    }
});

module.exports = router;